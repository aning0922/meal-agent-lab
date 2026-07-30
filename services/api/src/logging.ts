import type { Writable } from "node:stream";

import pino, { type LogFn, type Logger } from "pino";

/**
 * 阶段 09A / M3A：中央 logger 边界。
 *
 * ## 这一层现在的职责范围（第十三轮收口之后）
 *
 * 前九轮的路子是「让这一层能安全地吃下任意对象」——净化器一轮补一个洞：原型污染、
 * 有状态 Proxy、装箱字符串、继承访问器、结构键、索引访问器……每一轮都还能再找出
 * 一个。那条路走不到头，因为它试图在**出口**证明一个关于任意输入的全称命题。
 *
 * 第十轮起换了方向：业务代码不把任意对象交给 logger。
 *
 * **口径要写实**：Fastify 仍然暴露 `app.log` / `request.log`——那是框架的 API，
 * 这一层管不着。真正成立的是：**本仓库的业务调用点由 capability gate 约束**
 * （`tests/unit/production-log-arguments.test.ts`，按 pino/fastify 的声明身份判定），
 * 而业务事件走一条**独立**的 `EventLogSink`：它的底座是
 * `createLoggingContext()` 新建的、与 framework 分开的另一个 pino 根，闭包持有，
 * 不出现在 `app.log` / `request.log` / 任何公开返回值上。
 * `src/log-events.ts` 是一层窄化的 typed facade——事件是闭集，每个事件有**固定的
 * runtime projector**（逐个字段按名字取值，不遍历调用方传进来的对象），字段类型
 * 是**专用安全类型**而不是自由字符串：`errorType` 带 brand 且运行期在 allowlist
 * 里验一次，`errorCode` 用项目真实的 `ApiErrorCode`，`signal` 只允许
 * SIGINT/SIGTERM；验不过就抛错。`event` 是保留字段，调用方没有任何路径能覆盖。
 *
 * 静态门禁（`tests/unit/production-log-arguments.test.ts`）用 TypeScript 的 type
 * checker 限制的是**整项 logger capability**，不只是「调用」：任何类型为 `LogFn`
 * 的表达式（含 `Reflect.apply`、高阶转发、`as unknown as` 类型擦除之前的那一次
 * 取用）都只允许出现在 facade 与本文件里；`child`/`setBindings` 这类 mutation
 * API 只有本文件可以碰；组装根 `src/app.ts` 只能**传递** logger，不能在它上面做
 * 任何成员访问。
 *
 * 因此本文件里的净化器**不再是业务日志的安全依据**，它的职责收窄成**纵深防御**，
 * 只覆盖两类绕不过去的输入：
 *
 *   1. Fastify **自己**打的请求日志（`incoming request`、`request completed`、
 *      defaultErrorLog）——框架直接调 logger，不经过 facade；
 *   2. 第三方或未来代码万一直接拿到 logger 时的兜底。
 *
 * 这个定位很重要：**不要再为「任意对象 / Proxy」增补特例**。真正的边界在类型
 * 系统与 capability gate 那一侧，这里只保证已知的框架路径不泄漏。
 *
 * 关于 `Proxy`：下面每一处提到它的注释说的都是同一件事——描述符读取本身在 Proxy
 * 上会触发 trap，因此这一层保证的是「**不读取访问器**」，不是「绝不执行任何调用方
 * 代码」。那是 JavaScript 语言层面的性质，不是这一层的疏漏。
 *
 * ## 信任上下文仍然只有两个
 *
 * 任何一处输出都必须明确属于其中之一。这一层的划分比「再补一个 sentinel 判断」
 * 重要得多——先前几轮的漏网无一例外都是「某条路径悄悄拿到了 log-record 的豁免」。
 *
 *   1. **strict / untrusted canonicalizer**（`canonicalizeUntrusted`）
 *      child bindings、`setBindings()`、`formatters.level` / `formatters.bindings`、
 *      调用方 formatter / serializer 的返回值——全部走它。（子 logger 的
 *      `redact` 第八轮起整条拒绝，因此这里不再有 censor 这条入口。）
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
 * Fastify 交下来的那一个**（见 `registerRequestLogFields`），其余一律按不可信
 * 取值处理；
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

/**
 * 已登记的敏感键族。
 *
 * **口径（不夸大）**：这是一份人工维护的名单，它只对**这些已登记的键族**提供
 * 纵深防御。它**不**声称对任意第三方键或中性键（`traceContext`、`correlation`
 * 之类）里的 Secret 有任何兜底——那类取值在键名上看不出任何线索，靠黑名单是补不
 * 完的（第十一轮就是被裸的 `apiKey` 抓出来的）。
 *
 * 业务日志的安全性**不依赖这份名单**：业务代码只持有
 * `src/log-events.ts` 的 `EventLogSink`，事件字段是闭集且类型受控，binding 根本
 * 挂不上去。这份名单覆盖的是 Fastify 框架自己打的请求日志那条绕不过 facade 的
 * 路径。
 */
const sensitiveKeys = new Set([
  "authorization",
  // `Proxy-Authorization` 与 `X-API-Key` 归一化之后就是这两个。写成带分隔符的
  // 形式永远匹配不上——`set-cookie` 那条规则就是这么白写了好几轮的。
  "proxyauthorization",
  "xapikey",
  "cookie",
  // `isSensitiveKey` 先去掉分隔符再小写，所以这里必须写**归一化之后**的形式。
  // 名单里原来写的是 `"set-cookie"`，它归一化成 `setcookie`，因此永远匹配不上
  // 自己——一条从来没生效过的规则。
  "setcookie",
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
  // `IncomingMessage.rawHeaders` / `rawTrailers` 是**扁平字符串数组**（["authorization",
  // "Bearer …", "cookie", "…"]），因此逐键判断根本看不到里面的 authorization 与
  // cookie。把整条数组按敏感键处理——只要有人把整个 request 记在一个非 `req` 的
  // 键下面，这就是唯一的拦截点。（pino 的 `redact` 已经整条不用，因此不存在
  // `redact.paths` 这条后备。）
  "rawheaders",
  "rawtrailers",
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith("token") ||
    // `apiKey` / `serviceApiKey` / `X-API-Key` 归一化之后都以 `apikey` 结尾。
    // 第十一轮的 child-binding 反例就是被裸的 `apiKey` 抓出来的：名单里只登记了
    // `xapikey`，而后缀规则里没有 `apikey`。
    normalized.endsWith("apikey") ||
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
/**
 * 名单是**模块私有**的。
 *
 * 上一版导出的是一个 `ReadonlySet<string>`——那只是类型上的只读：
 * `(allowedErrorTypes as Set<string>).add("EVIL")` 在运行期照样成功，于是任何
 * 拿得到这个模块的人都能给自己开一个后门。现在对外只有两样东西：一个**冻结的
 * canonical 数组**（给漂移测试用）和一个 **predicate**（给运行期校验用），两者都
 * 无法反过来改动名单本身。
 */
const allowedErrorTypes: ReadonlySet<string> = new Set([
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
  // DOMException 家族：`name` 是 `DOMException.prototype` 上的访问器，因此靠
  // 上面那条 platformAccessorHolders 豁免才读得到。
  "AbortError",
  "TimeoutError",
  "FastifyError",
  "ZodError",
]);

/** 名单的**不可变**快照。冻结数组，改它不会影响判定。 */
export const canonicalErrorTypeNames: readonly string[] = Object.freeze([
  ...allowedErrorTypes,
]);

/** 唯一对外的判定入口。 */
export const isAllowedErrorType = (name: unknown): boolean =>
  typeof name === "string" && allowedErrorTypes.has(name);

const safeErrorTypeName = (name: unknown): string =>
  isAllowedErrorType(name) ? (name as string) : "Error";

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
/**
 * 唯一被允许执行的「平台访问器」持有者。
 *
 * `AbortError` / `TimeoutError` 在 Node 上是 `DOMException`，而它的 `name` 是
 * `DOMException.prototype` 上的**访问器**——纯数据属性规则会把它们全部折成
 * `Error`，于是 allowlist 里那个 `AbortError` 永远不可能被输出（实测：
 * `AbortSignal.timeout` 触发的拒绝也是 DOMException，日志里只有 `"Error"`）。
 *
 * 这条豁免是**可证明**的，不是「看起来像」：持有者对象必须 `===`
 * `DOMException.prototype`，那是我们自己从 `globalThis` 上取到的身份，调用方
 * 伪造不出来。执行的是平台代码，不是调用方代码。
 */
const domExceptionNameGetter: (() => unknown) | undefined = (() => {
  if (typeof DOMException !== "function") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    DOMException.prototype,
    "name",
  );
  return descriptor === undefined ? undefined : descriptor.get;
})();

const safeErrorTypeOf = (value: unknown, key: PropertyKey): string => {
  if (
    key === "name" &&
    domExceptionNameGetter !== undefined &&
    value !== null &&
    typeof value === "object"
  ) {
    const resolved = resolveDescriptor(value, key);
    // 身份判据是**函数本身**，不是它所在的那个原型对象。
    // `DOMException.prototype` 是可变的：只要检查「持有者是那个原型」就调用当时
    // 解析出来的 getter，等于把执行权交给任何能改写它的人（实测：改写之后 getter
    // 被执行 1 次）。这里比对的是模块加载时抓下来的**原始函数引用**，改写之后
    // 身份不再相等，直接降级。
    if (
      resolved !== undefined &&
      !("value" in resolved.descriptor) &&
      resolved.descriptor.get === domExceptionNameGetter
    ) {
      try {
        return safeErrorTypeName(domExceptionNameGetter.call(value));
      } catch {
        return "Error";
      }
    }
  }
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
/**
 * 新建一个**不会被原型污染劫持**的容器。
 *
 * canonicalizer 造出来的 `{}` 与 `[]` 仍然继承 `Object.prototype` /
 * `Array.prototype`。只要有人往那上面挂一个 `toJSON`，`JSON.stringify` 阶段就会
 * 调用它，于是整棵已经脱敏干净的树被一句返回值替换掉。实测：
 * `Object.prototype.toJSON = () => "<DSN>"` 之后，`logger.info({ nested: { a: 1 } })`
 * 打出的是那条带口令的连接串。索引访问器那条路已经堵上了，但 `Proxy` 的 trap
 * 仍然可以在我们枚举的过程中完成污染。
 *
 * 因此每个新建容器都带一条**不可枚举**的自身 `toJSON: undefined`：它遮蔽原型上
 * 的同名属性，`typeof value.toJSON === "function"` 因此为假，`JSON.stringify`
 * 直接走常规序列化；不可枚举保证它自己不会出现在输出里。
 */
const shieldFromPrototypeToJson = <T extends object>(target: T): T => {
  Object.defineProperty(target, "toJSON", {
    value: undefined,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return target;
};

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

/**
 * 递归深度的**硬上界**。
 *
 * `seen` 只挡得住环，挡不住深度：一条 5000 层的普通嵌套链就能让一次日志调用把
 * 整个进程的栈耗光（实测 `RangeError: Maximum call stack size exceeded`）。真实
 * 日志记录不会有这么深，因此到界就换成固定占位串，而不是让调用崩掉。
 */
const maximumCanonicalDepth = 64;
const tooDeepPlaceholder = "[TooDeep]";

export const canonicalizeUntrusted = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown => {
  if (depth > maximumCanonicalDepth) {
    return tooDeepPlaceholder;
  }
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
      const items: unknown[] = shieldFromPrototypeToJson([]);
      // 真实数组的 `length` 是自身数据属性。注意 `Array.isArray` 对**包着数组的
      // Proxy** 同样返回 true，那时这一读会触发 `get` trap——见文件头的 Proxy
      // 边界说明，这一层保证的是「不读取访问器」，不是「不执行任何调用方代码」。
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
        items.push(canonicalizeUntrusted(descriptor.value, seen, depth + 1));
      }
      return items;
    }
    const used = new Set<string>();
    const result: Record<string, unknown> = shieldFromPrototypeToJson({});
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
        canonicalizeUntrusted(descriptor.value, seen, depth + 1),
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
/**
 * 请求身份：**在 Fastify 的可信边界上物化好的纯数据**。
 *
 * 边界收窄的方向是明确的：logger 这一层不再做「任意对象 / Proxy 净化器」，也不
 * 再替调用方去读任何字段。字段由 `app.ts` 在 `genReqId(rawRequest)` 里读——那是
 * Fastify 刚把 request 交给我们、还没有经过任何调用方之手的唯一一刻，读的是
 * 平台自己的对象。读完就物化成四个原始值传进来。
 *
 * 因此这个登记函数**不调用任何访问器、不读任何属性**：传进来的对象只当 WeakMap
 * 的键用，取值全部来自参数。非字符串的字段一律丢弃——登记的必须是已经物化的纯
 * 数据，而不是「等会儿再读」的承诺。
 */
interface RequestLogFields {
  readonly requestId: string;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly remoteAddress: string | undefined;
}

const requestLogSnapshots = new WeakMap<object, RequestLogFields>();

const plainString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const registerRequestLogFields = (
  raw: unknown,
  fields: RequestLogFields,
): void => {
  if (raw === null || typeof raw !== "object") {
    return;
  }
  requestLogSnapshots.set(
    raw,
    Object.freeze({
      requestId: plainString(fields.requestId) ?? "",
      method: plainString(fields.method),
      path: plainString(fields.path),
      remoteAddress: plainString(fields.remoteAddress),
    }),
  );
};

/**
 * 沿 `raw` / `request` 找出候选对象背后那份快照。
 *
 * **有界**。`request` 这条链是调用方可以随便造的：两个互指的对象就能让它无限
 * 递归，一次日志调用把整个进程的栈耗光（实测
 * `RangeError: Maximum call stack size exceeded`）。上界取小值——真实形状最多
 * reply → request → raw 两跳。
 */
const maximumRequestChainDepth = 4;

const snapshotOf = (
  value: unknown,
  depth = 0,
): RequestLogFields | undefined => {
  if (
    depth > maximumRequestChainDepth ||
    value === null ||
    typeof value !== "object"
  ) {
    return undefined;
  }
  const direct = requestLogSnapshots.get(value);
  if (direct !== undefined) {
    return direct;
  }
  for (const key of ["raw", "request"] as const) {
    const next = readDataField(value, key);
    if (next.kind === "value" && next.value !== value) {
      const found = snapshotOf(next.value, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

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
  key === "err" || snapshotOf(value) !== undefined;

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

/**
 * 顶层 record 的描述符快照。**整条链路只抓一次**，`carriesError` 与后面的
 * canonicalization 共用同一份。
 *
 * 分两次抓是有洞的：中间的对象可以是**有状态的 Proxy**，第一次 `ownKeys` /
 * `getOwnPropertyDescriptor` 报告一套形状（不含 `err`），第二次换另一套。一次
 * 快照之后，后面的每一步看到的都是同一组已经物化的键值对。
 */
const snapshotLogRecord = (
  record: Record<string, unknown>,
): readonly (readonly [string, unknown, boolean])[] => ownDataEntries(record);

const recordCarriesError = (
  entries: readonly (readonly [string, unknown, boolean])[],
): boolean => entries.some(([key]) => key === "err");

const canonicalizeLogRecord = (
  record: Record<string, unknown>,
  entries: readonly (readonly [string, unknown, boolean])[] = snapshotLogRecord(
    record,
  ),
): Record<string, unknown> => {
  const seen = new WeakSet<object>();
  const used = new Set<string>();
  const result: Record<string, unknown> = shieldFromPrototypeToJson({});
  for (const [key, value, isAccessor] of entries) {
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
  const result: Record<string, unknown> = shieldFromPrototypeToJson({});
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
// 固定 serializer：只为**框架自动请求日志**保留的纵深防御
// ---------------------------------------------------------------------------
// 业务代码第十轮起走 `src/log-events.ts` 的 typed facade，不再产生 `req`/`res`/
// `err` 这三个键。留着这三个 serializer 是因为 Fastify 自己会直接调 logger 打
// `incoming request` / `request completed` / defaultErrorLog——那条路径绕不过
// facade，仍然需要投影与脱敏。
//
// 换句话说：它们现在是**纵深防御**，不是业务日志的安全依据。不要再往这里加
// 「任意对象 / Proxy」的特例。

const pathOf = (url: FieldRead): unknown =>
  url.kind === "value" && typeof url.value === "string"
    ? url.value.split("?")[0]
    : url.kind === "accessor"
      ? accessorPlaceholder
      : undefined;

/**
 * request 的**固定投影**。
 *
 *   - 有快照：整条记录**就是那份冻结的快照**，serializer 一个字段都不从候选对象
 *     上读。因此伪造 wrapper 就算指向真实请求，也只会打出真实请求的信息；而一个
 *     被登记进来的自造对象只会拿回它自己那份用数据属性拼出来的快照。
 *   - 没有快照：只读数据属性，访问器记成占位串、不被读取。Node 的
 *     `IncomingMessage` 把 `method`/`url`/`socket` 放在自身数据属性上，所以即便
 *     是不可信输入，只要它真带着一个 IncomingMessage 形状的东西，也拿得到有用
 *     信息。
 */
const serializeRequest = (request: unknown): unknown => {
  const snapshot = snapshotOf(request);
  if (snapshot !== undefined) {
    // 已经是纯数据了，仍然过一遍文本脱敏——path 是调用方完全可控的文本。
    return canonicalizeUntrusted({
      requestId: snapshot.requestId,
      method: snapshot.method,
      path: snapshot.path,
      remoteAddress: snapshot.remoteAddress,
    });
  }

  const untrustedRaw = fieldValue(readDataField(request, "raw"));
  const socket = fieldValue(
    firstField(
      readDataField(request, "socket"),
      readDataField(untrustedRaw, "socket"),
    ),
  );
  return canonicalizeUntrusted({
    requestId: fieldValue(readDataField(request, "id")),
    method: fieldValue(
      firstField(
        readDataField(request, "method"),
        readDataField(untrustedRaw, "method"),
      ),
    ),
    path: pathOf(
      firstField(
        readDataField(request, "url"),
        readDataField(untrustedRaw, "url"),
      ),
    ),
    remoteAddress: fieldValue(
      firstField(
        readDataField(request, "remoteAddress"),
        readDataField(request, "ip"),
        readDataField(socket, "remoteAddress"),
      ),
    ),
  });
};

/**
 * reply 的固定投影。
 *
 * 这一条不需要「可信」这个概念：`ServerResponse` 的 `statusCode` 是**数据属性**
 * （实测），因此经由 `raw` 读它对两类输入是同一条路径，永远不会读访问器。状态码
 * 会在请求生命周期里变化，所以它不能进登记点的那份冻结快照。
 */
const serializeResponse = (response: unknown): unknown =>
  canonicalizeUntrusted({
    statusCode: fieldValue(
      firstField(
        readDataField(fieldValue(readDataField(response, "raw")), "statusCode"),
        readDataField(response, "statusCode"),
      ),
    ),
  });

/**
 * 从任意取值取出**已归一化的错误类型名**（一定在 allowlist 里）。
 *
 * 这是原始 Error 与业务日志之间**唯一**的桥：`src/log-events.ts` 的 facade 用它
 * 填 `errorType` 字段，原始对象本身到不了 logger。
 *
 * 第十轮起业务代码不再自己拼 `{ err: … }` record——能记的事件是闭集，字段是显式
 * 声明的专用安全类型。第十一轮起 `errorType` 还带 brand：它**只能**由
 * `eventErrorType()` 产生，随便一个字符串字面量在类型上就赋不进来。
 */
export const errorTypeOf = (error: unknown): string =>
  canonicalizeError(error).type;

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

  // 子 logger **一律不得自带 `redact`**。
  //
  // 包装 censor 是不够的：`redact` 的路径语义本身就决定了**哪些键**会被送进
  // pino 的 redactor，而那条路径（`@pinojs/redact`）会先做选择性克隆、再序列化
  // 克隆体，克隆体带不上我们给容器加的 `toJSON` 遮蔽——被污染的
  // `Object.prototype.toJSON` 于是又能在序列化阶段把整棵脱敏干净的树替换掉。
  // 根 logger 不配置 `redact`（第七轮移除，它的两类路径都已被固定 serializer 与
  // canonicalizer 覆盖），子 logger 也不能把它带回来。
  //
  // 兼容面不受影响：Fastify 只会把 `serializers` 再传一遍
  // （`lib/logger-pino.js`），从不传 `redact`。
  if ("redact" in snapshot) {
    throw new Error(
      "child loggers may not configure redact; redaction is enforced at the " +
        "central logger boundary",
    );
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
/**
 * 框架 logger 与业务事件 logger 的**分离容器**。
 *
 * 它们是**两个独立的 pino 根实例**，只是写向同一个目的地。这条分离是必须的：
 *
 *   - `framework` 交给 Fastify。它会被 Fastify 派生成请求作用域的子 logger，也
 *     可能被调用方预先绑定过 binding；
 *   - `events` 只喂给 `createEventLogSink()`，**永不**出现在 `app.log` /
 *     `request.log` / 任何公开返回值上。
 *
 * 因此：预绑定在 framework 上的 binding 到不了业务事件；sink 建好之后再对
 * framework root `setBindings()` 也影响不到业务事件——两者根本不是同一棵树。
 */
export interface LoggingContext {
  readonly framework: Logger;
  readonly events: Logger;
}

/**
 * 建立分离容器。
 *
 * `framework` 允许由调用方注入（测试要捕获框架日志）；`events` **永远**由这里
 * 新建，调用方没有任何入口把一个预绑定的 logger 塞进业务事件底座。
 */
export const createLoggingContext = (
  level: string,
  framework?: Logger,
  destination?: Writable,
): LoggingContext => ({
  framework: framework ?? createLogger(level, destination),
  events: createLogger(level, destination),
});

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
            // 那条已经封掉的路径。
            //
            // 上一轮只在 msg 与 `err.message` **逐字相同**时才折叠。那条判据是
            // 可以绕开的：包装一层、截一段、加个前缀，msg 就不再相等，而它携带的
            // 仍然是同一段内部细节。现在的判据只有一条——**这条记录带不带
            // `err`**；带就无条件折成固定串。
            //
            // 代价是明确的：`log.error({ err }, "API startup failed")` 这类调用
            // 方自己写的 msg 也会变成固定串。诊断信息从 `err.type` 走（它来自
            // allowlist），不再从 msg 走。不带 `err` 的普通日志完全不受影响。
            const record = (args as readonly unknown[])[0];
            const isRecordObject =
              record !== null &&
              typeof record === "object" &&
              !Array.isArray(record) &&
              !(record instanceof Error);
            // **一次**描述符快照，后面 carriesError 与 canonicalization 共用。
            // 分两次抓的话，一个有状态的 Proxy 可以先报「没有 err」、再报「有」。
            const entries = isRecordObject
              ? snapshotLogRecord(record as Record<string, unknown>)
              : undefined;
            const carriesError =
              record instanceof Error ||
              (entries !== undefined && recordCarriesError(entries));
            const safe = (args as readonly unknown[]).map(
              (argument, index) => {
                // index 1 是 msg。record 带 `err` 时它**无条件**折成固定串，而且
                // 不看类型——`new String("…")` 这种装箱字符串 `typeof` 是
                // "object"，上一版的 `typeof === "string"` 判据会把它整条放过去。
                // index > 1 是 printf 插值参数，仍然按普通不可信取值处理。
                if (index === 1 && carriesError) {
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
                  if (entries !== undefined) {
                    return canonicalizeLogRecord(
                      argument as Record<string, unknown>,
                      entries,
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
        // pino 的 `redact` 已经**没有存在意义，而且有害**，因此这里不再配置。
        //
        // 没有意义：原来的路径分两类，`req.headers.*` 与 `*.authorization` 之类。
        // 前者在固定 serializer 把 request 投影成 4 个字段之后根本不会出现；后者
        // 的键名（authorization / loginCode / inviteCode / accessToken /
        // providerSubject / providerUnionSubject / wechatAppSecret /
        // dietaryConstraints）本来就在 `sensitiveKeys` 里，而 canonicalizer 是
        // **任意深度**按键名脱敏的，覆盖面严格更大。
        //
        // 有害：`@pinojs/redact` 会先做一次**选择性克隆**再序列化克隆体
        // （index.js:522 `serialize(cloned)`），而且只要存在 `*` 通配路径，pino 就
        // 会把**每一个键**都送进这个 redactor（tools.js: `stringifiers[key] ||
        // wildcardStringifier`）。克隆体是库自己新建的对象，带不上我们给容器加的
        // `toJSON` 遮蔽，于是被污染的 `Object.prototype.toJSON` /
        // `Array.prototype.toJSON` 又能在 `JSON.stringify` 阶段把整棵已经脱敏干净
        // 的树替换成一句返回值（实测泄漏）。去掉这一层之后，序列化走 pino 自己的
        // `JSON.stringify`，我们的遮蔽因此真正生效。
        //
        // 子 logger 仍然可以自己传 `redact`，那条路径上的 censor 依旧被
        // `hardenChildOptions` 包起来。
      },
      stream,
    ),
  );
