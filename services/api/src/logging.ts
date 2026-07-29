import type { Writable } from "node:stream";

import pino, { type LogFn, type Logger } from "pino";

/**
 * 阶段 09A / M3A：日志脱敏的**信任上下文**只有两个，任何一处输出都必须明确
 * 属于其中之一。这一层的划分比「再补一个 sentinel 判断」重要得多——先前几轮
 * 的漏网无一例外都是「某条路径悄悄拿到了 log-record 的豁免」。
 *
 *   1. **strict / untrusted canonicalizer**（`canonicalizeUntrusted`）
 *      child bindings、`setBindings()`、`formatters.level` / `formatters.bindings`、
 *      调用方 formatter / serializer / censor 的返回值——全部走它。
 *      它**没有** `req`/`res`/`err` 豁免，同时处理**属性名与属性值**，一律按
 *      描述符读取而**不读取访问器**，不调用 `toJSON`/`toString` 之类的用户函数，
 *      并把 `Error` 归一化成受控形状。
 *
 *   2. **log-record canonicalizer**（`canonicalizeLogRecord`）
 *      只有**真正的顶层 log record** 才允许把 `req`/`res`/`err` 延后交给固定
 *      serializer。固定 serializer 一律新建纯对象，且它们的产物**再走一次**
 *      strict canonicalizer。
 *
 * 因此「伪造一个 req 键」拿不到任何豁免：`req`/`res` 的延后只发给**能证明是
 * Fastify 交下来的那一个**（见 `trustRawRequest`），其余一律按不可信取值处理；
 * 而固定 serializer 对不可信输入本来也只走数据属性，产物还会再被 strict 收一遍。
 *
 * ## 这一层保证的边界（不夸大）
 *
 * 保证的是「**不读取访问器**」：普通对象、数组下标、Error 的 name/type、
 * req/res 的字段，全部经 `Object.getOwnPropertyDescriptor` 解析，是数据属性才取值。
 *
 * **不**保证「绝不执行任何调用方代码」。`Proxy` 会让 `Object.keys`、
 * `getOwnPropertyDescriptor`、`getPrototypeOf`（`instanceof` 用它）各自触发对应的
 * trap；`Array.isArray` 对包着数组的 Proxy 同样返回 true。那是 JavaScript 语言
 * 层面的性质，这一层消除不了。真正的兜底在别处：trap 的返回值仍然要走同一套
 * 描述符规则与文本脱敏，因此它能让代码跑，但拿不到「把 Secret 原样写出去」这个
 * 结果。
 */

const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "code",
  "invitecode",
  "logincode",
  "token",
  "accesstoken",
  "sessiontoken",
  "tokendigest",
  "openid",
  "unionid",
  "providersubject",
  "providerunionsubject",
  "session_key",
  "sessionkey",
  "appsecret",
  "wechatappsecret",
  "dietaryconstraints",
  "memberprivateconstraints",
  // 数据库凭据与连接串的常见命名。归一化会去掉分隔符并转小写，因此
  // `database_url`、`databaseUrl`、`DATABASE-URL` 都落在同一个键上。
  "databaseurl",
  "connectionstring",
  "connectionuri",
  "conninfo",
  "dsn",
  "password",
  "dbpassword",
  "pgpassword",
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("openid") ||
    normalized.endsWith("unionid") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("databaseurl") ||
    normalized.endsWith("connectionstring") ||
    normalized.endsWith("connectionuri") ||
    normalized.endsWith("dsn")
  );
};

// ---------------------------------------------------------------------------
// 取值层面的脱敏
// ---------------------------------------------------------------------------

/**
 * 只按键名不够：`{ note: "postgresql://app:pw@db/meal_agent" }` 的键完全无害，
 * 值却是一整条带口令的连接串。整条连接串一次性替换掉，因此口令的原值与
 * URL 百分号编码形态会**同时**消失。
 *
 * libpq 的 key/value conninfo 不是 URL，单独覆盖一次，并且是**保守**的：
 * 带引号带空格的取值无法用一条正则可靠地找到结束位置，因此一旦看到
 * `password=` 就把**其后的全部文本**删掉。
 */
const connectionStringPattern = /postgres(?:ql)?:\/\/\S*/gi;
const conninfoPasswordPattern = /pass(?:word|file)\s*=[\s\S]*$/i;
// `.test()` 会推进带 `g` 标志的正则的 lastIndex，因此探测用**独立、无 g** 的副本。
const connectionStringProbe = /postgres(?:ql)?:\/\//i;
const conninfoPasswordProbe = /pass(?:word|file)\s*=/i;

/**
 * 单轮解码。整串 `decodeURIComponent` 在遇到 `%ZZ` 这种畸形前缀时会**整条抛错**，
 * 于是「畸形前缀 + 合法编码连接串」就能骗过探测。因此抛错时回落到逐个
 * `%XX` 的宽松解码：能解的解开，解不开的原样留下。
 */
const decodePercentEncodingOnce = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
  }
};

/** 重复解码的**硬上界**：多重编码要跟到底，但绝不允许出现无界循环。 */
const maximumDecodeRounds = 4;

/**
 * 判断一段文本在**任意层百分号编码之下**是否藏着连接串或 conninfo。
 *
 * 算法有界，但达到上界时**不能**返回「安全」：那正好是「编码层数比上界还多」
 * 的情形，也就是最可疑的一种。因此收敛（再解也不变）才算安全；仍在变化就
 * fail closed。代价是极少数「连解四轮还在变」的无害文本会被多脱敏一次。
 */
const containsEncodedConnectionSecret = (value: string): boolean => {
  if (!value.includes("%")) {
    return false;
  }
  let current = value;
  for (let round = 0; round < maximumDecodeRounds; round += 1) {
    const decoded = decodePercentEncodingOnce(current);
    if (decoded === current) {
      // 收敛：再解也不会变。`100% done`、`50%25` 这类正常文本走到这里。
      return false;
    }
    if (
      connectionStringProbe.test(decoded) ||
      conninfoPasswordProbe.test(decoded)
    ) {
      return true;
    }
    current = decoded;
  }
  // 到达上界但仍在继续解码：无法证明它不含 Secret，因此按含有处理。
  return true;
};

export const redactText = (value: string): string => {
  if (containsEncodedConnectionSecret(value)) {
    return "[Redacted]";
  }
  return value
    .replace(connectionStringPattern, "[Redacted]")
    .replace(conninfoPasswordPattern, "password=[Redacted]");
};

// ---------------------------------------------------------------------------
// 键名层面的脱敏
// ---------------------------------------------------------------------------

const redactedKeyPlaceholder = "[RedactedKey]";
const accessorPlaceholder = "[Getter]";

// ---------------------------------------------------------------------------
// 描述符读取：唯一被允许的「从不可信取值上拿字段」的方式
// ---------------------------------------------------------------------------

/**
 * 一次字段读取的三种结局。把「读到了 `undefined`」与「那里是个访问器」和
 * 「根本不存在」分开——降级策略依赖这个区分。
 */
type FieldRead =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "accessor" }
  | { readonly kind: "absent" };

const absentField: FieldRead = { kind: "absent" };
const accessorField: FieldRead = { kind: "accessor" };

/**
 * 沿**原型链**解析描述符，返回第一个持有该键的层。
 *
 * 为什么必须沿链走：`Object.getOwnPropertyDescriptor(value, "name")` 对
 * `class Boom extends Error { get name() { … } }` 的实例返回 `undefined`——那个
 * 访问器在原型上。只看自身描述符然后「没有就普通读一次」等于把继承访问器又执行
 * 了一遍。
 *
 * 边界（不夸大）：`getOwnPropertyDescriptor` 与 `getPrototypeOf` 在 `Proxy` 上
 * 会触发对应的 trap，因此对 `Proxy` 而言「不执行调用方代码」这句话不成立。这是
 * JavaScript 语言层面的性质，不是本文件能单方面消除的；本文件保证的是**不读取
 * 访问器**，不是「绝不执行任何调用方代码」。
 */
const resolveDescriptor = (
  target: object,
  key: PropertyKey,
): { readonly holder: object; readonly descriptor: PropertyDescriptor } | undefined => {
  let holder: object | null = target;
  while (holder !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor !== undefined) {
      return { holder, descriptor };
    }
    holder = Object.getPrototypeOf(holder) as object | null;
  }
  return undefined;
};

/**
 * 只在**能证明是数据属性**（自身或继承）时返回取值；访问器只报告它存在。
 * 证明不了就降级——这是刻意的 fail closed 方向。
 */
const readDataField = (target: unknown, key: PropertyKey): FieldRead => {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    return absentField;
  }
  const resolved = resolveDescriptor(target, key);
  if (resolved === undefined) {
    return absentField;
  }
  return "value" in resolved.descriptor
    ? { kind: "value", value: resolved.descriptor.value }
    : accessorField;
};

/** 按顺序取第一个真正读到取值的候选；都没有时保留「见过访问器」这个事实。 */
const firstField = (...reads: readonly FieldRead[]): FieldRead => {
  let sawAccessor = false;
  for (const read of reads) {
    if (read.kind === "value" && read.value !== undefined) {
      return read;
    }
    if (read.kind === "accessor") {
      sawAccessor = true;
    }
  }
  return sawAccessor ? accessorField : absentField;
};

/** 把一次读取折成可以直接写进日志的取值。 */
const fieldValue = (read: FieldRead): unknown =>
  read.kind === "value"
    ? read.value
    : read.kind === "accessor"
      ? accessorPlaceholder
      : undefined;

/**
 * 属性**名**同样可能就是 Secret（`{ [dsn]: "x" }`）。名字里出现连接串/conninfo
 * 时整条替换成固定占位串。
 *
 * 替换会让多个不同的键塌缩成同一个名字，因此按出现顺序编号——确定、可复现，
 * 而且编号本身只泄漏「有几个」，不泄漏内容。
 */
/**
 * 会遮蔽 `Object.prototype` 成员的键必须改名。
 *
 * 这不是洁癖：pino 的 `asChindings()` 直接写 `bindings.hasOwnProperty(key)`
 * （`lib/tools.js`），因此一条 `{"hasOwnProperty": "shadowed"}` 的 binding 会让
 * pino 自己抛 `TypeError` —— 不可信输入把整条日志链打断了。`__proto__` 同理，
 * 改名之后下游也不可能再碰到原型访问器。
 */
const structuralKeyNames = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);
const structuralKeyPrefix = "[Structural]";

const safeKeyName = (key: string, used: Set<string>): string => {
  const redacted = redactText(key) === key ? key : redactedKeyPlaceholder;
  const base = structuralKeyNames.has(redacted)
    ? `${structuralKeyPrefix}${redacted}`
    : redacted;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}:${String(index)}`)) {
    index += 1;
  }
  const unique = `${base}:${String(index)}`;
  used.add(unique);
  return unique;
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Error 归一化后的固定 message。
 *
 * 它覆盖的是**经由 `err` 字段**进入日志的错误：`canonicalizeError` 把 message
 * 换成这一串，pino 的 `write()` 也就只能取到它。调用方**显式**把一段文本当 msg
 * 传进来时（例如 Fastify 的 defaultErrorLog 会传 `error.message`），走的是另一条
 * 路径，由下面 `logMethod` 里的那条专门规则处理。
 */
export const safeErrorMessage = "request failed";

/**
 * `Error.name` 是调用方完全可写的字段。这里用**精确 allowlist**，不用「格式
 * 正则即可信」——`SimplePasswordSecret123` 这种名字完全符合类名文法，却是一段
 * 可以由攻击面写入的自由文本。名单之外一律固定输出 `Error`。
 *
 * 名单 = 本仓库真实定义的错误类（`grep 'this.name ='` 得到）+ 运行时会自然
 * 出现的内建与依赖错误类型。新增错误类时必须同步登记，否则日志里只会看到
 * `Error`——这是刻意的 fail closed 方向。
 */
export const allowedErrorTypes: ReadonlySet<string> = new Set([
  // 本仓库定义的
  "AppError",
  "AuthorizationManifestError",
  "AuthorizationRenderError",
  "BootstrapCliUsageError",
  "MigrationCliUsageError",
  "MigrationLockTimeoutError",
  "MigrationOptionError",
  "MigrationPreflightError",
  "MigrationSelectionError",
  "SecretSourceError",
  "Stage06ManifestError",
  // 内建
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  // 运行期常见依赖
  "AbortError",
  "FastifyError",
  "ZodError",
]);

const safeErrorTypeName = (name: unknown): string =>
  typeof name === "string" && allowedErrorTypes.has(name) ? name : "Error";

/**
 * 从取值上**按描述符**取类型名。
 *
 * `value.name` 这种普通成员读取会执行访问器，而 `Error.name` 是调用方完全可写
 * 的字段：既可以是自身访问器（`Object.defineProperty(err, "name", { get })`），
 * 也可以是子类原型上的继承访问器。两种都不能读。
 *
 * 因此这里沿原型链解析描述符，只有落点是**数据属性**且落在 allowlist 里才采用；
 * 访问器、不存在、非字符串、不在名单里——一律降级为 `Error`。
 *
 * 正常类型不会因此丢失：`Error.prototype.name` / `TypeError.prototype.name` 都是
 * 数据属性，本仓库的错误类则在构造函数里 `this.name = …`（自身数据属性）。
 */
const safeErrorTypeOf = (value: unknown, key: PropertyKey): string => {
  const read = readDataField(value, key);
  return read.kind === "value" ? safeErrorTypeName(read.value) : "Error";
};

/**
 * 把任意取值折成固定的 `{ type, message }`。
 *
 * 它必须在**交给 pino 之前**完成：`pino.write()` 在 `msg === undefined` 时会
 * 直接取 `_obj.message` 或 `_obj[errorKey].message` 生成顶层 `msg`——那条路径
 * 完全绕过 serializer。因此「只在 serializer 里安全化」是不够的。
 */
const canonicalizeError = (value: unknown): {
  type: string;
  message: string;
} => ({
  type: value instanceof Error
    ? safeErrorTypeOf(value, "name")
    : // 已经被折过一次的形状可以保留 type——但只有**在 allowlist 里**、而且它
      // 确实是个数据属性才行。伪造 `{ type: <任意文本> }` 或
      // `{ get type() { … } }` 都拿不到任何东西。
      safeErrorTypeOf(value, "type"),
  message: safeErrorMessage,
});

// ---------------------------------------------------------------------------
// 1. strict / untrusted canonicalizer
// ---------------------------------------------------------------------------

/**
 * 返回值一定是由字符串、数字、布尔、null、数组和**纯对象**构成的树，因此
 * 后续的 `JSON.stringify` 阶段不会再碰到调用方提供的 `toJSON`/`toString`。
 *
 *   - 函数值（含 own enumerable 的 `toJSON`/`toString`）替换成占位串，不被调用；
 *   - `Error` 归一化成 `{ type, message }`，`type` 走受控文法；
 *   - 键名与取值都脱敏；
 *   - 循环引用防护对对象与数组共用，并按**路径**记录（递归返回后移除），因此
 *     同一个对象作为兄弟节点出现两次不会被误判为循环。
 */
/**
 * 写入一个键，且**不触发任何 setter**。
 *
 * `result[key] = v` 在 `key` 是 `__proto__` 时会命中 `Object.prototype` 上的
 * 访问器，把原型换掉而不是新建一条属性；`defineProperty` 没有这个问题，
 * `hasOwnProperty` 这类结构键也只是普通字符串键。
 */
const defineSafeProperty = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

export const canonicalizeUntrusted = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "bigint") {
    // `String(bigint)` 走的是抽象 ToString，**不会**调用可被覆写的
    // `BigInt.prototype.toString`；结果再过一遍文本脱敏。
    // （直接 `value.toString()` 会执行输入方，那是不可信代码。）
    return redactText(String(value));
  }
  if (typeof value === "symbol") {
    return "[Symbol]";
  }
  if (value instanceof Error) {
    return canonicalizeError(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // 逐项复制到**全新数组**，不用 `map`/迭代器/`Symbol.species`——这三者
      // 都可被输入覆写，等于让不可信数据决定执行哪段代码。
      //
      // 索引也必须按描述符读：数组下标同样可以是访问器
      // （`Object.defineProperty(a, 0, { get() { … } })`），`value[index]` 会把它
      // 执行掉。稀疏洞记 `undefined`，访问器记固定占位串。
      const items: unknown[] = [];
      // 真实数组（`Array.isArray` 为真）的 `length` 必然是自身数据属性，读它
      // 不可能触发调用方代码。
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) {
          items.push(undefined);
          continue;
        }
        if (!("value" in descriptor)) {
          items.push(accessorPlaceholder);
          continue;
        }
        items.push(canonicalizeUntrusted(descriptor.value, seen));
      }
      return items;
    }
    const used = new Set<string>();
    const result: Record<string, unknown> = {};
    // `Object.keys` 只列自身可枚举字符串键，取值另用描述符读，因此**访问器
    // 不会被读取**。
    //
    // 措辞到此为止，不能再往上说。对普通对象而言这等于「不执行调用方代码」；
    // 对 `Proxy` 而言并不成立——`Object.keys` 会触发 `ownKeys` 与逐键的
    // `getOwnPropertyDescriptor` trap，`Array.isArray` 对包着数组的 Proxy 返回
    // true，连 `instanceof` 都会触发 `getPrototypeOf` trap。这些是 JavaScript
    // 语言层面的性质，本文件消除不了。本文件保证的是「不读取访问器」，不是
    // 「绝不执行任何调用方代码」。
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const safe = safeKeyName(key, used);
      if (descriptor === undefined) {
        defineSafeProperty(result, safe, undefined);
        continue;
      }
      if (isSensitiveKey(key)) {
        defineSafeProperty(result, safe, "[Redacted]");
        continue;
      }
      if (!("value" in descriptor)) {
        // 访问器：只记录它存在，绝不调用。
        defineSafeProperty(result, safe, accessorPlaceholder);
        continue;
      }
      defineSafeProperty(
        result,
        safe,
        canonicalizeUntrusted(descriptor.value, seen),
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

/** 兼容既有调用方的别名：它就是 strict canonicalizer。 */
export const redactSensitive = canonicalizeUntrusted;

// ---------------------------------------------------------------------------
// 2. log-record canonicalizer
// ---------------------------------------------------------------------------

/**
 * `req` / `res` / `err` 由各自的**固定** serializer 投影成安全形状。豁免只在
 * 这一层成立，而且只是「延后」，不是「放行」：serializer 的产物会再走一次
 * strict canonicalizer。
 */
const serializedKeys = new Set(["req", "res", "err"]);

/**
 * 一个 `req`/`res`/`err` 键能否延后给固定 serializer。
 *
 * `err` 永远延后——但延后的形状已经是 `canonicalizeError()` 折好的安全对象，
 * 不是调用方的原对象。`req`/`res` 只有在**能证明是 Fastify 交下来的那一个**
 * 时才延后；伪造的一律当普通不可信取值处理。
 *
 * 说明：这条收紧是**纵深防御**。固定 serializer 自己对伪造输入也只走数据属性，
 * 所以即便 pino 后续仍按键名跑一次 serializer，也不会执行调用方的访问器。
 */
const mayDeferToSerializer = (key: string, value: unknown): boolean =>
  key === "err" ||
  (key === "req" && isGenuineRequest(value)) ||
  (key === "res" && isGenuineReply(value));

/**
 * 记录层也不能用 `Object.entries`：那会**读**每一个属性，从而执行输入自带的
 * getter。这里只取自有数据属性；访问器一律记成 `[Getter]`，连 `req`/`res`/`err`
 * 的延后豁免都不给——豁免的前提是「这确实是 Fastify 交下来的那个对象」，一个
 * 访问器不满足这个前提。
 */
const ownDataEntries = (
  record: Record<string, unknown>,
): readonly (readonly [string, unknown, boolean])[] =>
  Object.keys(record).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || "value" in descriptor
      ? ([key, descriptor?.value, false] as const)
      : ([key, accessorPlaceholder, true] as const);
  });

const canonicalizeLogRecord = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const seen = new WeakSet<object>();
  const used = new Set<string>();
  const result: Record<string, unknown> = {};
  for (const [key, value, isAccessor] of ownDataEntries(record)) {
    if (
      serializedKeys.has(key) &&
      !isAccessor &&
      mayDeferToSerializer(key, value)
    ) {
      // `err` 必须在**这里**就折成安全形状：pino 的 write() 会在 msg 缺省时
      // 直接取 `_obj[errorKey].message` 当顶层 msg，那条路径完全绕过 serializer。
      defineSafeProperty(
        result,
        key,
        key === "err" ? canonicalizeError(value) : value,
      );
      used.add(key);
      continue;
    }
    defineSafeProperty(
      result,
      safeKeyName(key, used),
      isSensitiveKey(key)
        ? "[Redacted]"
        : isAccessor
          ? accessorPlaceholder
          : canonicalizeUntrusted(value, seen),
    );
  }
  return result;
};

/**
 * 调用方自带 `formatters.log` 时用这一条：它的返回值整体不可信，但**原样透传
 * 下来的** `req`/`res`/`err`（与输入记录里那一个是同一个对象）仍然可以延后给
 * serializer。凡是 formatter 自己造出来的，一律按 untrusted 处理。
 */
const canonicalizeFormatterRecord = (
  produced: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const seen = new WeakSet<object>();
  const used = new Set<string>();
  const result: Record<string, unknown> = {};
  for (const [key, value, isAccessor] of ownDataEntries(produced)) {
    if (
      serializedKeys.has(key) &&
      !isAccessor &&
      value !== undefined &&
      value === fieldValue(readDataField(source, key)) &&
      mayDeferToSerializer(key, value)
    ) {
      defineSafeProperty(
        result,
        key,
        key === "err" ? canonicalizeError(value) : value,
      );
      used.add(key);
      continue;
    }
    defineSafeProperty(
      result,
      safeKeyName(key, used),
      isSensitiveKey(key)
        ? "[Redacted]"
        : isAccessor
          ? accessorPlaceholder
          : canonicalizeUntrusted(value, seen),
    );
  }
  return result;
};

// ---------------------------------------------------------------------------
// 固定 serializer：一律新建纯对象，产物再走一次 strict canonicalizer
// ---------------------------------------------------------------------------

/**
 * 真正由 Fastify 交下来的 request / reply 才配得上「读原型访问器」这条待遇。
 *
 * 实测（fastify 5.10.0）：`method` / `url` / `ip` / `socket` / `headers` 都是
 * `Request.prototype` 上的**访问器**，`statusCode` 是 `Reply.prototype` 上的
 * 访问器。它们是框架自己的代码，不是调用方数据；而伪造对象上的同名访问器是
 * 调用方代码，绝不能执行。因此这两类必须先被区分开，不能一起「普通成员读取」。
 *
 * 可信标识建立在**最早**的那个点上：`genReqId(rawRequest)` 由 Fastify 在构造
 * `Request`、也在打出 "incoming request" 之前调用。实测顺序确实是
 * `incoming request` → `onRequest` hook，所以 `onRequest` 里登记来不及，第一条
 * 请求日志会漏。`app.ts` 在 `genReqId` 里登记原始 `IncomingMessage`；之后一个
 * 对象只要**自身数据属性** `raw` 指向已登记的那一个，就是货真价实的 Fastify
 * Request。伪造对象拿不到这条：它的 `raw` 要么不存在，要么不是已登记的对象。
 */
const trustedRawRequests = new WeakSet<object>();

export const trustRawRequest = (raw: unknown): void => {
  if (raw !== null && typeof raw === "object") {
    trustedRawRequests.add(raw);
  }
};

const isGenuineRequest = (value: unknown): boolean => {
  const raw = readDataField(value, "raw");
  return (
    raw.kind === "value" &&
    raw.value !== null &&
    typeof raw.value === "object" &&
    trustedRawRequests.has(raw.value)
  );
};

/** Fastify 的 Reply 把它的 Request 放在**自身数据属性** `request` 上。 */
const isGenuineReply = (value: unknown): boolean => {
  const request = readDataField(value, "request");
  return request.kind === "value" && isGenuineRequest(request.value);
};

/** 已确认可信的对象才走这条：读取会执行框架自己的原型访问器。 */
const readTrustedField = (target: unknown, key: string): FieldRead => {
  if (target === null || typeof target !== "object") {
    return absentField;
  }
  try {
    return { kind: "value", value: (target as Record<string, unknown>)[key] };
  } catch {
    // 框架访问器也可能抛（例如 socket 已经销毁）。抛错不该把日志调用带走。
    return absentField;
  }
};

const readField = (
  target: unknown,
  key: string,
  trusted: boolean,
): FieldRead =>
  trusted ? readTrustedField(target, key) : readDataField(target, key);

/**
 * request 的**固定投影**。不可信输入只走数据属性，因此伪造的
 * `{ get url() { … } }` 不会被执行，只会记成占位串。
 *
 * 不可信路径也不会一无所获：Node 的 `IncomingMessage` 把 `method`/`url`/
 * `socket`/`headers` 放在**自身数据属性**上（实测），所以经由 `raw` 这条路径
 * 不需要执行任何访问器就能拿到请求信息。
 */
const serializeRequest = (request: unknown): unknown => {
  const trusted = isGenuineRequest(request);
  const raw = fieldValue(readDataField(request, "raw"));

  const urlRead = firstField(
    readField(request, "url", trusted),
    readDataField(raw, "url"),
  );
  const url = urlRead.kind === "value" ? urlRead.value : undefined;

  const socket = fieldValue(
    firstField(
      readField(request, "socket", trusted),
      readDataField(raw, "socket"),
    ),
  );

  return canonicalizeUntrusted({
    requestId: fieldValue(readDataField(request, "id")),
    method: fieldValue(
      firstField(
        readField(request, "method", trusted),
        readDataField(raw, "method"),
      ),
    ),
    // 请求目标是调用方完全可控的文本；strict canonicalizer 会再脱敏一次。
    path:
      typeof url === "string"
        ? url.split("?")[0]
        : urlRead.kind === "accessor"
          ? accessorPlaceholder
          : undefined,
    // Fastify 的 Request 上没有 `remoteAddress`——只读那一个字段会让这一列永远
    // 缺席。按 Fastify → Node socket 顺序取。
    remoteAddress: fieldValue(
      firstField(
        readField(request, "remoteAddress", trusted),
        readField(request, "ip", trusted),
        readField(socket, "remoteAddress", trusted),
      ),
    ),
  });
};

/** reply 的固定投影，口径与 request 完全一致。 */
const serializeResponse = (response: unknown): unknown => {
  const trusted = isGenuineReply(response);
  const raw = fieldValue(readDataField(response, "raw"));
  return canonicalizeUntrusted({
    statusCode: fieldValue(
      firstField(
        readField(response, "statusCode", trusted),
        readDataField(raw, "statusCode"),
      ),
    ),
  });
};

const serializeError = (error: unknown): unknown =>
  // 绝不返回调用方的原对象。type 只可能来自 allowlist，因此伪造一个
  // `{ type: <任意文本> }` 拿不到任何东西。
  canonicalizeUntrusted(canonicalizeError(error));

// ---------------------------------------------------------------------------
// 子 logger 的公开变更入口
// ---------------------------------------------------------------------------

/**
 * `serializers`、`formatters.*`、`redact.censor` 与 `msgPrefix` 都在我们的
 * canonicalizer **之后**参与输出，因此各自都能把刚脱敏掉的取值重新生成出来。
 *
 * 这里选择**安全包装**而不是一刀切拒绝：Fastify 自己就带着 options 调用
 * `child()`（`lib/logger-pino.js` 会把父 logger 的 serializers 再传一遍）。
 * 包装口径统一是「先让调用方的函数跑，再把结果交给 strict canonicalizer」。
 */
const hardenChildOptions = (options: unknown): unknown => {
  if (options === null || typeof options !== "object") {
    return options;
  }
  // 一次性快照：`{ ...source }` 会对每个自身可枚举键做一次 `[[Get]]`，随后下面
  // 每个键又各读一次——同一个访问器至少跑两遍，而且两次的返回值可以不同（先给
  // 一个能通过 typeof 校验的形状，再给真正写进输出的那个）。这里改成读一次、
  // 之后全部复用。
  //
  // 口径说明：child options 是**配置**，不是不可信数据（这条边界在上一轮已经定
  // 下：Secret/键值是不可信数据，logger 配置回调是受信代码或被拒绝）。因此这里
  // 允许访问器跑，但只跑一次。
  const source = options as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      continue;
    }
    snapshot[key] = "value" in descriptor
      ? descriptor.value
      : descriptor.get === undefined
        ? undefined
        : descriptor.get.call(source);
  }
  const hardened: Record<string, unknown> = { ...snapshot };

  const serializers = snapshot["serializers"];
  if (serializers !== null && typeof serializers === "object") {
    hardened["serializers"] = Object.fromEntries(
      Object.keys(serializers as Record<string, unknown>).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(
          serializers as Record<string, unknown>,
          key,
        )?.value,
      ] as const).map(
        ([key, serializer]) => [
          key,
          typeof serializer === "function"
            ? (value: unknown) =>
                canonicalizeUntrusted(
                  (serializer as (input: unknown) => unknown)(value),
                )
            : serializer,
        ],
      ),
    );
  }

  // 子 logger 的 formatters 会**替换**父 logger 的同名 formatter，因此这里必须
  // 显式补回我们的那一层。三个入口都要包：`level` 的返回值同样会被合并进最终
  // 输出，`customLevels` + `formatters.level` 是一条完整的注入路径。
  const formatters = snapshot["formatters"];
  if (formatters !== null && typeof formatters === "object") {
    const provided = formatters as Record<string, unknown>;
    const next: Record<string, unknown> = { ...provided };

    const log = provided["log"];
    next["log"] =
      typeof log === "function"
        ? (object: object) =>
            canonicalizeFormatterRecord(
              (log as (input: object) => object)(object) as Record<
                string,
                unknown
              >,
              object as Record<string, unknown>,
            )
        : canonicalizeLogRecord;

    const bindings = provided["bindings"];
    if (typeof bindings === "function") {
      next["bindings"] = (input: Record<string, unknown>) =>
        canonicalizeUntrusted(
          (bindings as (value: Record<string, unknown>) => object)(input),
        );
    }

    const level = provided["level"];
    if (typeof level === "function") {
      next["level"] = (label: string, number: number) =>
        canonicalizeUntrusted(
          (level as (label: string, number: number) => object)(label, number),
        );
    }

    hardened["formatters"] = next;
  }

  // msgPrefix 是在我们的 logMethod **之后**才被拼到 msg 前面的。
  const msgPrefix = snapshot["msgPrefix"];
  if (typeof msgPrefix === "string") {
    hardened["msgPrefix"] = redactText(msgPrefix);
  }

  // redact.censor 的返回值直接进入输出；函数与字符串两种形态都要过一遍。
  const redact = snapshot["redact"];
  if (redact !== undefined && !Array.isArray(redact)) {
    if (redact === null || typeof redact !== "object") {
      throw new Error(
        "logger child redact must be an array of paths or an options object",
      );
    }
    const next = { ...(redact as Record<string, unknown>) };
    const censor = next["censor"];
    if (typeof censor === "function") {
      next["censor"] = (value: unknown, path: readonly string[]) =>
        canonicalizeUntrusted(
          (censor as (input: unknown, at: readonly string[]) => unknown)(
            value,
            path,
          ),
        );
    } else if (typeof censor === "string") {
      next["censor"] = redactText(censor);
    } else if (censor !== undefined) {
      // Pino 的契约只有「字符串」与「(value, path) => any」两种 censor。别的形态
      // 会被原样当成替换值写进输出，而我们无法对一个未知形态做等价包装。
      throw new Error(
        "logger child redact.censor must be a string or a function; " +
          `received ${typeof censor}`,
      );
    }
    hardened["redact"] = next;
  }

  return hardened;
};

/**
 * 封闭 pino 的两个公开变更入口。
 *
 * pino 的 `child()` 用 `Object.create(this)` 建子 logger，因此子 logger 通过
 * **原型链**继承这里安装的两个覆盖——只要覆盖内部用**动态 `this`**，每一层
 * 操作的就都是它自己那个实例。用 `bind()` 把 root 绑死会让 grandchild 从 root
 * 派生、`child.setBindings()` 改到 root 上去（都已实测）。
 */
const hardenLogger = (logger: Logger): Logger => {
  const inheritedChild = logger.child as unknown as (
    this: Logger,
    bindings: Record<string, unknown>,
    options?: unknown,
  ) => Logger;
  Object.defineProperty(logger, "child", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (
      this: Logger,
      bindings: Record<string, unknown>,
      options?: unknown,
    ): Logger {
      return inheritedChild.call(
        this,
        // bindings 是不可信输入，没有任何 req/res/err 豁免。
        canonicalizeUntrusted(bindings ?? {}) as Record<string, unknown>,
        hardenChildOptions(options),
      );
    },
  });

  const inheritedSetBindings = logger.setBindings as unknown as (
    this: Logger,
    bindings: Record<string, unknown>,
  ) => void;
  Object.defineProperty(logger, "setBindings", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (this: Logger, bindings: Record<string, unknown>): void {
      inheritedSetBindings.call(
        this,
        canonicalizeUntrusted(bindings ?? {}) as Record<string, unknown>,
      );
    },
  });

  return logger;
};

/**
 * 脱敏落在**中央 logger 边界**，不依赖任何调用方主动配合：
 *
 *   - `hooks.logMethod`：在 pino 做 printf 插值**之前**处理全部参数；
 *   - `formatters.log`：顶层 log record（唯一允许延后 req/res/err 的地方）；
 *   - `child()` / `setBindings()` 覆盖 + 子 logger options 包装：不可信输入；
 *   - 固定 serializer：新建纯对象并再走一次 strict；
 *   - `redact.paths`：与前面几层独立的最后一道。
 */
export const createLogger = (
  level: string,
  stream?: Writable,
): Logger =>
  hardenLogger(
    pino(
      {
        level,
        base: null,
        formatters: {
          log: canonicalizeLogRecord,
        },
        hooks: {
          logMethod(
            this: Logger,
            args: Parameters<LogFn>,
            method: LogFn,
          ): void {
            // Fastify 的 defaultErrorLog 会调用
            // `reply.log.error({ req, res, err }, error?.message)`——msg 是一段
            // **显式传入的字符串**，因此绕开了「pino 从 err.message 自动生成 msg」
            // 那条已经封掉的路径。这里按描述符取出 err 的 message，凡是与它逐字
            // 相同的 msg 一律换成固定串：错误内部细节不该因为换了个入口就泄漏。
            const record = (args as readonly unknown[])[0];
            const carriedErrorMessage =
              record instanceof Error
                ? readDataField(record, "message")
                : record !== null && typeof record === "object"
                  ? readDataField(
                      fieldValue(
                        readDataField(record as Record<string, unknown>, "err"),
                      ),
                      "message",
                    )
                  : absentField;
            const safe = (args as readonly unknown[]).map(
              (argument, index) => {
                if (
                  index > 0 &&
                  typeof argument === "string" &&
                  carriedErrorMessage.kind === "value" &&
                  argument === carriedErrorMessage.value
                ) {
                  return safeErrorMessage;
                }
                if (typeof argument === "string") {
                  return redactText(argument);
                }
                if (index === 0) {
                  // 第一个参数是**合并对象**——唯一的顶层 log record。它必须走
                  // 与 `formatters.log` 相同的那一层，否则用通用 canonicalizer
                  // 直接拍平会把 Fastify 的 Request 变成普通对象，`method`/`url`
                  // 这些原型取值器全部消失（日志看起来没泄漏，其实丢了信息）。
                  //
                  // Error **不能**原样传给 pino：`write()` 在 msg 缺省时会直接
                  // 取 `_obj.message` 当顶层 msg，那条路径绕过 serializer 与
                  // formatters。折成安全形状后 pino 最多取到固定 message。
                  if (argument instanceof Error) {
                    return { err: canonicalizeError(argument) };
                  }
                  if (
                    argument !== null &&
                    typeof argument === "object" &&
                    !Array.isArray(argument)
                  ) {
                    return canonicalizeLogRecord(
                      argument as Record<string, unknown>,
                    );
                  }
                }
                return canonicalizeUntrusted(argument);
              },
            ) as Parameters<LogFn>;
            method.apply(this, safe);
          },
        },
        serializers: {
          req: serializeRequest,
          res: serializeResponse,
          err: serializeError,
        },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "*.authorization",
            "*.loginCode",
            "*.inviteCode",
            "*.accessToken",
            "*.providerSubject",
            "*.providerUnionSubject",
            "*.wechatAppSecret",
            "*.dietaryConstraints",
          ],
          censor: "[Redacted]",
        },
      },
      stream,
    ),
  );
