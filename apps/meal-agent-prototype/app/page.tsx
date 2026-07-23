"use client";

import { useMemo, useRef, useState } from "react";

type ScreenId =
  | "o01"
  | "o02"
  | "o03"
  | "o04"
  | "o05"
  | "h01"
  | "r01"
  | "r02"
  | "r03"
  | "s01"
  | "s02"
  | "c01"
  | "c02"
  | "c03"
  | "c04"
  | "c05";

type MenuPlan = {
  id: string;
  objective: string;
  title: string;
  dishes: string;
  time: string;
  active: string;
  difficulty: string;
  coverage: string;
  missing: string[];
  uses: string[];
  reason: string;
  assumption: string;
  equipment: string;
  cookSteps: Array<{ title: string; detail: string; safety?: string }>;
  deductions: Array<{
    id: string;
    name: string;
    batch: string;
    amount: number;
    unit: string;
  }>;
};

type DishOption = {
  id: string;
  category: "主食" | "主菜" | "蔬菜" | "凉菜";
  title: string;
  summary: string;
  recommended: boolean;
  minutes: number;
  activeMinutes: number;
  difficulty: string;
  coverage: number;
  missing: string[];
  uses: string[];
  reason: string;
  equipment: string[];
  cookSteps: Array<{ title: string; detail: string; safety?: string }>;
  deductions: MenuPlan["deductions"];
};

type ShoppingItem = {
  id: string;
  name: string;
  quantity: string;
  source: string;
  purchased: boolean;
  actor?: string;
};

const pageGroups: Array<{
  title: string;
  pages: Array<{ id: ScreenId; code: string; label: string }>;
}> = [
  {
    title: "首次引导",
    pages: [
      { id: "o01", code: "O-01", label: "首次欢迎" },
      { id: "o02", code: "O-02", label: "成员与硬约束" },
      { id: "o03", code: "O-03", label: "厨艺与厨具" },
      { id: "o04", code: "O-04", label: "常备调味品" },
      { id: "o05", code: "O-05", label: "首批食材" },
    ],
  },
  {
    title: "今天吃什么",
    pages: [
      { id: "h01", code: "H-01", label: "今天" },
      { id: "r01", code: "R-01", label: "本餐条件" },
      { id: "r02", code: "R-02", label: "建议组合与加菜" },
      { id: "r03", code: "R-03", label: "本餐组合详情" },
    ],
  },
  {
    title: "共享采购",
    pages: [
      { id: "s01", code: "S-01", label: "共享采购" },
      { id: "s02", code: "S-02", label: "已买待入库" },
    ],
  },
  {
    title: "做饭与扣减",
    pages: [
      { id: "c01", code: "C-01", label: "开始前检查" },
      { id: "c02", code: "C-02", label: "做饭模式" },
      { id: "c03", code: "C-03", label: "完成状态" },
      { id: "c04", code: "C-04", label: "库存扣减与回库" },
      { id: "c05", code: "C-05", label: "完成回执" },
    ],
  },
];

const pageMeta: Record<
  ScreenId,
  { code: string; title: string; risk: string; observe: string[] }
> = {
  o01: {
    code: "O-01",
    title: "首次欢迎",
    risk: "录入成本",
    observe: ["是否理解不必盘点整个冰箱", "是否愿意从 5 项食材开始"],
  },
  o02: {
    code: "O-02",
    title: "成员与硬约束",
    risk: "录入成本",
    observe: ["硬约束与普通偏好是否分得清", "跳过是否会被理解为未知"],
  },
  o03: {
    code: "O-03",
    title: "厨艺与厨具",
    risk: "录入成本",
    observe: ["选择是否足够轻量", "是否知道按本餐厨师过滤难度"],
  },
  o04: {
    code: "O-04",
    title: "常备调味品",
    risk: "录入成本",
    observe: ["模板是否比逐项搜索更省力", "未知项是否不会被默认为没有"],
  },
  o05: {
    code: "O-05",
    title: "首批食材",
    risk: "录入成本",
    observe: ["能否用模糊数量连续添加 5 项", "是否会被日期与精确重量阻塞"],
  },
  h01: {
    code: "H-01",
    title: "今天",
    risk: "任务入口",
    observe: ["今天吃什么是否是第一主操作", "临期信息是否清楚区分来源"],
  },
  r01: {
    code: "R-01",
    title: "本餐条件",
    risk: "录入成本",
    observe: ["默认值是否可信且易改", "永久约束与本次偏好是否混淆"],
  },
  r02: {
    code: "R-02",
    title: "建议组合与加菜",
    risk: "组合选择效率",
    observe: ["是否理解系统建议做几道菜", "能否快速增减并看懂整餐变化"],
  },
  r03: {
    code: "R-03",
    title: "本餐组合详情",
    risk: "菜单可信度",
    observe: ["选择前最新校验是否建立信任", "采购项与预计扣减是否透明"],
  },
  s01: {
    code: "S-01",
    title: "共享采购",
    risk: "协作清晰度",
    observe: ["来源与最后操作者是否清楚", "已买是否会被误认为已入库"],
  },
  s02: {
    code: "S-02",
    title: "已买待入库",
    risk: "录入成本",
    observe: ["能否批量补齐最少信息", "数量与日期是否允许保持模糊或未知"],
  },
  c01: {
    code: "C-01",
    title: "开始前检查",
    risk: "执行可信度",
    observe: ["开火前是否能发现缺少项", "安全提示是否足够醒目但不过载"],
  },
  c02: {
    code: "C-02",
    title: "做饭模式",
    risk: "执行效率",
    observe: ["当前步骤、用量与安全点是否清楚", "暂停恢复入口是否可发现"],
  },
  c03: {
    code: "C-03",
    title: "完成状态",
    risk: "餐后扣减",
    observe: ["是否理解做完不等于已经扣库存", "部分完成是否符合真实情况"],
  },
  c04: {
    code: "C-04",
    title: "库存扣减与回库",
    risk: "餐后扣减",
    observe: ["45 秒内能否调整、排除并回库", "冲突重算与具体批次是否容易理解"],
  },
  c05: {
    code: "C-05",
    title: "完成回执",
    risk: "闭环信心",
    observe: ["是否确信扣减已记录", "剩菜新批次与轻反馈是否清楚"],
  },
};

const dishOptions: DishOption[] = [
  {
    id: "tomato-noodles",
    category: "主食",
    title: "番茄鸡蛋面",
    summary: "一锅主食，优先处理番茄和鸡蛋",
    recommended: true,
    minutes: 30,
    activeMinutes: 18,
    difficulty: "新手友好",
    coverage: 78,
    missing: ["鲜面条", "小葱"],
    uses: ["番茄 2 个", "鸡蛋 3 个"],
    reason: "作为主食能保证饱腹，并优先用掉明天需处理的番茄。",
    equipment: ["炒锅", "汤锅"],
    cookSteps: [
      {
        title: "备菜与煮面",
        detail: "番茄切块，鸡蛋 3 个打散；面条下锅煮至合适软硬。",
      },
      {
        title: "炒番茄鸡蛋",
        detail: "炒鸡蛋与番茄，加少量面汤后与面条合并。",
        safety: "鸡蛋中心需完全凝固；生熟餐具分开。",
      },
    ],
    deductions: [
      {
        id: "egg",
        name: "鸡蛋",
        batch: "冷藏 · 7月22日购入",
        amount: 3,
        unit: "个",
      },
      {
        id: "tomato",
        name: "番茄",
        batch: "冷藏 · 7月21日购入",
        amount: 2,
        unit: "个",
      },
      {
        id: "noodles",
        name: "鲜面条",
        batch: "刚入库 · 标签日期未填",
        amount: 0.5,
        unit: "袋",
      },
      {
        id: "scallion",
        name: "小葱",
        batch: "刚入库 · 约一把",
        amount: 0.3,
        unit: "把",
      },
    ],
  },
  {
    id: "greens",
    category: "蔬菜",
    title: "清炒上海青",
    summary: "补一份蔬菜，与主食并行完成",
    recommended: true,
    minutes: 10,
    activeMinutes: 8,
    difficulty: "简单",
    coverage: 100,
    missing: [],
    uses: ["上海青 1 袋"],
    reason: "两人晚餐建议至少有一份蔬菜，现有库存可以直接完成。",
    equipment: ["炒锅"],
    cookSteps: [
      {
        title: "清炒上海青",
        detail: "上海青洗净沥水，大火快炒，断生后立即盛出。",
      },
    ],
    deductions: [
      {
        id: "greens",
        name: "上海青",
        batch: "冷藏 · 数量为估算",
        amount: 1,
        unit: "袋",
      },
    ],
  },
  {
    id: "minced-tofu",
    category: "主菜",
    title: "肉末豆腐",
    summary: "想更丰盛时加一道下饭主菜",
    recommended: false,
    minutes: 20,
    activeMinutes: 15,
    difficulty: "简单",
    coverage: 68,
    missing: ["猪肉末"],
    uses: ["豆腐 1 盒"],
    reason: "增加蛋白质和份量，但会增加一项采购与一口锅的占用。",
    equipment: ["炒锅"],
    cookSteps: [
      {
        title: "准备豆腐",
        detail: "豆腐切块，猪肉末拆散备用。",
      },
      {
        title: "炒肉末豆腐",
        detail: "肉末炒至变色，加入豆腐和少量水焖 6 分钟。",
        safety: "猪肉末需彻底熟透，不以颜色单独判断。",
      },
    ],
    deductions: [
      {
        id: "tofu",
        name: "豆腐",
        batch: "冷藏 · 标签到期 7月25日",
        amount: 1,
        unit: "盒",
      },
      {
        id: "pork",
        name: "猪肉末",
        batch: "刚入库 · 冷藏",
        amount: 0.5,
        unit: "盒",
      },
    ],
  },
  {
    id: "cucumber",
    category: "凉菜",
    title: "凉拌黄瓜",
    summary: "8 分钟加一道清爽凉菜",
    recommended: false,
    minutes: 8,
    activeMinutes: 8,
    difficulty: "非常简单",
    coverage: 40,
    missing: ["黄瓜"],
    uses: [],
    reason: "不会占用灶台，但需要额外购买黄瓜。",
    equipment: [],
    cookSteps: [
      {
        title: "拌黄瓜",
        detail: "黄瓜拍碎后调味，食用前再拌匀。",
      },
    ],
    deductions: [
      {
        id: "cucumber",
        name: "黄瓜",
        batch: "刚入库 · 约2根",
        amount: 1,
        unit: "根",
      },
    ],
  },
  {
    id: "cola-wings",
    category: "主菜",
    title: "可乐鸡翅",
    summary: "更符合口味，但时间与采购最多",
    recommended: false,
    minutes: 45,
    activeMinutes: 25,
    difficulty: "需要看火",
    coverage: 25,
    missing: ["鸡翅", "可乐"],
    uses: [],
    reason: "符合最近的显式口味反馈，但会把整餐时间拉长到 45 分钟。",
    equipment: ["炒锅"],
    cookSteps: [
      {
        title: "准备鸡翅",
        detail: "鸡翅擦干备用，确认接触生肉的台面易于清洁。",
      },
      {
        title: "煎焖鸡翅",
        detail: "鸡翅煎至表面上色，加可乐和生抽，小火焖 20 分钟。",
        safety: "禽肉中心需彻底熟透，接触生鸡肉后清洁双手与台面。",
      },
    ],
    deductions: [
      {
        id: "wings",
        name: "鸡翅",
        batch: "刚入库 · 冷藏",
        amount: 8,
        unit: "只",
      },
      {
        id: "cola",
        name: "可乐",
        batch: "刚入库 · 常温",
        amount: 0.5,
        unit: "瓶",
      },
    ],
  },
  {
    id: "mushroom-rice",
    category: "主食",
    title: "香菇胡萝卜焖饭",
    summary: "替换面食，电饭煲一次完成",
    recommended: false,
    minutes: 35,
    activeMinutes: 12,
    difficulty: "简单",
    coverage: 72,
    missing: ["香菇"],
    uses: ["熟米饭 2 碗", "胡萝卜 1 根"],
    reason: "动手时间少，但与番茄鸡蛋面同属主食，更适合作为替换而非叠加。",
    equipment: ["电饭煲"],
    cookSteps: [
      {
        title: "准备焖饭",
        detail: "香菇和胡萝卜切丁，与米饭和调味汁放入电饭煲。",
      },
      {
        title: "焖熟",
        detail: "按下煮饭键，完成后翻拌并保温 5 分钟。",
      },
    ],
    deductions: [
      {
        id: "rice",
        name: "熟米饭",
        batch: "冷藏 · 制作时间已记录",
        amount: 2,
        unit: "碗",
      },
      {
        id: "carrot",
        name: "胡萝卜",
        batch: "冷藏 · 日期未知",
        amount: 1,
        unit: "根",
      },
      {
        id: "mushroom",
        name: "香菇",
        batch: "刚入库 · 冷藏",
        amount: 1,
        unit: "盒",
      },
    ],
  },
];

const recommendedDishIds = dishOptions
  .filter((dish) => dish.recommended)
  .map((dish) => dish.id);

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function composeMenu(selectedIds: string[]): MenuPlan {
  const dishes = selectedIds
    .map((id) => dishOptions.find((dish) => dish.id === id))
    .filter((dish): dish is DishOption => Boolean(dish));
  const safeDishes = dishes.length
    ? dishes
    : dishOptions.filter((dish) => dish.recommended);
  const missing = uniqueValues(safeDishes.flatMap((dish) => dish.missing));
  const uses = uniqueValues(safeDishes.flatMap((dish) => dish.uses));
  const equipment = uniqueValues(
    safeDishes.flatMap((dish) => dish.equipment),
  );
  const deductions = Array.from(
    new Map(
      safeDishes
        .flatMap((dish) => dish.deductions)
        .map((item) => [item.id, item]),
    ).values(),
  );
  const maxMinutes = Math.max(...safeDishes.map((dish) => dish.minutes));
  const totalMinutes = maxMinutes + (safeDishes.length > 2 ? 5 : 0);
  const activeMinutes = safeDishes.reduce(
    (total, dish) => total + dish.activeMinutes,
    0,
  );
  const coverage = Math.round(
    safeDishes.reduce((total, dish) => total + dish.coverage, 0) /
      safeDishes.length,
  );

  return {
    id: selectedIds.join("--") || "recommended",
    objective: `已选 ${safeDishes.length} 道`,
    title: `今晚的 ${safeDishes.length} 道菜`,
    dishes: safeDishes.map((dish) => dish.title).join(" · "),
    time: `${totalMinutes} 分钟`,
    active: `${activeMinutes} 分钟`,
    difficulty: safeDishes.some((dish) => dish.difficulty === "需要看火")
      ? "需要看火"
      : "新手友好",
    coverage: `${coverage}%`,
    missing,
    uses,
    reason: `按 ${safeDishes.length} 道菜合并计算时间、采购和库存消耗；系统建议的 2 道已预先选中。`,
    assumption:
      "总时间按可并行步骤估算；假设家中有已确认的食用油、盐和酱油。",
    equipment: equipment.length ? equipment.join(" · ") : "无需特殊设备",
    cookSteps: safeDishes.flatMap((dish) =>
      dish.cookSteps.map((step) => ({
        ...step,
        title: `${dish.title} · ${step.title}`,
      })),
    ),
    deductions,
  };
}

const suggestedIngredients = [
  "鸡蛋",
  "番茄",
  "上海青",
  "豆腐",
  "熟米饭",
  "胡萝卜",
  "酸奶",
];

const initialIngredients = ["鸡蛋", "番茄", "上海青"];
const initialMenu = composeMenu(recommendedDishIds);

const defaultDeductionAmounts = Object.fromEntries(
  dishOptions.flatMap((dish) =>
    dish.deductions.map((item) => [item.id, item.amount]),
  ),
);

const initialShopping = (plan: MenuPlan): ShoppingItem[] => [
  ...plan.missing.map((name, index) => ({
    id: `${plan.id}-${index}`,
    name,
    quantity:
      name === "鲜面条"
        ? "1 袋"
        : name === "小葱"
          ? "1 把"
          : "约 1 份",
    source: plan.title,
    purchased: false,
  })),
  {
    id: "manual-paper",
    name: "厨房纸",
    quantity: "1 卷",
    source: "小北手动添加",
    purchased: false,
    actor: "小北 · 2分钟前",
  },
];

function ChoiceChip({
  active,
  children,
  onClick,
  small = false,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  small?: boolean;
}) {
  return (
    <button
      className={`choice-chip ${active ? "is-active" : ""} ${small ? "is-small" : ""}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ProgressDots({ current }: { current: number }) {
  return (
    <div className="progress-dots" aria-label={`首次引导第 ${current} 步，共 5 步`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <span className={step <= current ? "is-done" : ""} key={step} />
      ))}
      <b>{current}/5</b>
    </div>
  );
}

function PrototypeHeader({
  title,
  eyebrow,
  onBack,
  trailing,
}: {
  title: string;
  eyebrow?: string;
  onBack?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="prototype-header">
      <div>
        {onBack ? (
          <button
            aria-label="返回上一页"
            className="icon-button"
            onClick={onBack}
            type="button"
          >
            ←
          </button>
        ) : (
          <span className="header-spacer" />
        )}
      </div>
      <div className="header-title">
        {eyebrow && <span>{eyebrow}</span>}
        <strong>{title}</strong>
      </div>
      <div>{trailing ?? <span className="header-spacer" />}</div>
    </header>
  );
}

function BottomNav({
  active,
  onHome,
  onShopping,
  onOutOfScope,
}: {
  active: "home" | "shopping";
  onHome: () => void;
  onShopping: () => void;
  onOutOfScope: (label: string) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="一级导航">
      <button
        className={active === "home" ? "is-active" : ""}
        onClick={onHome}
        type="button"
      >
        <span>今</span>
        今天
      </button>
      <button onClick={() => onOutOfScope("库存")} type="button">
        <span>库</span>
        库存
      </button>
      <button
        className={active === "shopping" ? "is-active" : ""}
        onClick={onShopping}
        type="button"
      >
        <span>采</span>
        采购
      </button>
      <button onClick={() => onOutOfScope("家庭")} type="button">
        <span>家</span>
        家庭
      </button>
    </nav>
  );
}

export default function Home() {
  const [screen, setScreen] = useState<ScreenId>("o01");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [homeName, setHomeName] = useState("林然的家");
  const [selectedDiners, setSelectedDiners] = useState(["林然", "小北"]);
  const [hardConstraintConfirmed, setHardConstraintConfirmed] = useState(true);
  const [skill, setSkill] = useState("家常熟练");
  const [equipment, setEquipment] = useState(["炒锅", "汤锅", "电饭煲"]);
  const [pantry, setPantry] = useState(["食用油", "盐", "酱油", "醋"]);
  const [ingredients, setIngredients] = useState(initialIngredients);
  const [timeLimit, setTimeLimit] = useState("30");
  const [shoppingTolerance, setShoppingTolerance] = useState("少量补购");
  const [selectedDishIds, setSelectedDishIds] = useState<string[]>([
    ...recommendedDishIds,
  ]);
  const selectedMenu = useMemo(
    () => composeMenu(selectedDishIds),
    [selectedDishIds],
  );
  const selectedDishes = useMemo(
    () =>
      dishOptions.filter((dish) => selectedDishIds.includes(dish.id)),
    [selectedDishIds],
  );
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>(
    initialShopping(initialMenu),
  );
  const [inventoryConfirmed, setInventoryConfirmed] = useState(false);
  const [cookStep, setCookStep] = useState(0);
  const [completionState, setCompletionState] = useState<
    "all" | "partial" | "none"
  >("partial");
  const [includedDeductions, setIncludedDeductions] = useState<
    Record<string, boolean>
  >(() =>
    Object.fromEntries(
      dishOptions.flatMap((dish) =>
        dish.deductions.map((item) => [item.id, true]),
      ),
    ),
  );
  const [deductionAmounts, setDeductionAmounts] = useState<
    Record<string, number>
  >(defaultDeductionAmounts);
  const [leftover, setLeftover] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState<string[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);

  const currentMeta = pageMeta[screen];
  const purchasedCount = shoppingItems.filter((item) => item.purchased).length;
  const inventoryRows = shoppingItems.filter((item) => item.purchased);

  const navigate = (next: ScreenId) => {
    setScreen(next);
    setReviewOpen(false);
    setToast("");
    requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const showScopeNote = (label: string) => {
    setToast(`${label}完整页面不在本轮原型范围，可从评审目录继续核心闭环。`);
  };

  const resetPrototype = () => {
    setScreen("o01");
    setReviewOpen(false);
    setToast("");
    setHomeName("林然的家");
    setSelectedDiners(["林然", "小北"]);
    setHardConstraintConfirmed(true);
    setSkill("家常熟练");
    setEquipment(["炒锅", "汤锅", "电饭煲"]);
    setPantry(["食用油", "盐", "酱油", "醋"]);
    setIngredients(initialIngredients);
    setTimeLimit("30");
    setShoppingTolerance("少量补购");
    setSelectedDishIds([...recommendedDishIds]);
    setShoppingItems(initialShopping(initialMenu));
    setInventoryConfirmed(false);
    setCookStep(0);
    setCompletionState("partial");
    setIncludedDeductions(
      Object.fromEntries(
        dishOptions.flatMap((dish) =>
          dish.deductions.map((item) => [item.id, true]),
        ),
      ),
    );
    setDeductionAmounts(defaultDeductionAmounts);
    setLeftover(true);
    setConflict(false);
    setFeedback([]);
  };

  const toggleListValue = (
    value: string,
    list: string[],
    setter: (next: string[]) => void,
  ) => {
    setter(
      list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value],
    );
  };

  const confirmMenu = () => {
    setShoppingItems(initialShopping(selectedMenu));
    setInventoryConfirmed(false);
    navigate("s01");
  };

  const toggleDish = (dishId: string) => {
    setSelectedDishIds((current) => {
      if (current.includes(dishId)) {
        if (current.length === 1) {
          setToast("一餐至少保留 1 道菜。");
          return current;
        }
        setToast("");
        return current.filter((id) => id !== dishId);
      }

      if (current.length >= 3) {
        setToast("本餐最多选择 3 道菜，请先移除一道。");
        return current;
      }

      setToast("");
      return [...current, dishId];
    });
  };

  const updateShoppingItem = (id: string) => {
    setShoppingItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              purchased: !item.purchased,
              actor: !item.purchased ? "你 · 刚刚" : undefined,
            }
          : item,
      ),
    );
  };

  const simulateAllPurchased = () => {
    setShoppingItems((items) =>
      items.map((item) => ({
        ...item,
        purchased: true,
        actor: item.actor ?? "你 · 刚刚",
      })),
    );
  };

  const adjustDeduction = (id: string, delta: number) => {
    setDeductionAmounts((current) => ({
      ...current,
      [id]: Math.max(
        0,
        Math.round(((current[id] ?? 0) + delta) * 10) / 10,
      ),
    }));
  };

  const renderOnboarding = () => {
    if (screen === "o01") {
      return (
        <>
          <div className="onboarding-hero">
            <div className="wire-illustration" aria-hidden="true">
              <span />
              <span />
              <span />
              <b>一顿饭</b>
            </div>
            <p className="kicker">MEAL AGENT</p>
            <h1>先从今晚这一顿开始</h1>
            <p className="lead">
              不用盘点整个冰箱。录入 5–10 个确定存在或最想先消耗的食材，就能获得第一份可信菜单。
            </p>
          </div>
          <div className="value-path" aria-label="首次价值路径">
            <span>1 · 硬约束</span>
            <i>→</i>
            <span>2 · 少量食材</span>
            <i>→</i>
            <span>3 · 建议组合</span>
          </div>
          <div className="bottom-actions">
            <button
              className="primary-button"
              onClick={() => navigate("o02")}
              type="button"
            >
              创建我的家庭
            </button>
            <button
              className="text-button"
              onClick={() => navigate("h01")}
              type="button"
            >
              已有邀请，先看演示
            </button>
          </div>
        </>
      );
    }

    if (screen === "o02") {
      return (
        <>
          <PrototypeHeader
            eyebrow="首次设置"
            onBack={() => navigate("o01")}
            title="谁会一起吃饭？"
          />
          <div className="screen-body">
            <ProgressDots current={2} />
            <section className="intro-copy">
              <h1>先记不能出错的事</h1>
              <p>过敏和明确禁忌会参与每次推荐校验；普通口味可以以后再填。</p>
            </section>
            <div className="field-block">
              <label htmlFor="household-name">家庭名称</label>
              <input
                id="household-name"
                onChange={(event) => setHomeName(event.target.value)}
                value={homeName}
              />
            </div>
            <section className="person-card is-selected">
              <div className="avatar-box">林</div>
              <div>
                <strong>林然</strong>
                <p>家庭所有者 · 本餐默认参加</p>
              </div>
              <span className="check-mark">✓</span>
            </section>
            <section className="person-card is-selected">
              <div className="avatar-box">北</div>
              <div>
                <strong>小北</strong>
                <p>用餐档案 · 本餐默认参加</p>
              </div>
              <span className="check-mark">✓</span>
            </section>
            <button className="add-row" type="button">
              ＋ 添加家庭成员或用餐档案
            </button>
            <section className="constraint-box">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">硬约束 · 必须确认</span>
                  <h2>过敏与明确禁忌</h2>
                </div>
                <span className="hard-tag">不可绕过</span>
              </div>
              <label className="check-row">
                <input
                  checked={hardConstraintConfirmed}
                  onChange={(event) =>
                    setHardConstraintConfirmed(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>
                  <b>已确认：小北花生过敏</b>
                  <small>推荐、替代食材和调味品都必须排除花生</small>
                </span>
              </label>
              <button className="subtle-button" type="button">
                ＋ 添加其他过敏或禁忌
              </button>
            </section>
            <div className="unknown-note">
              <b>普通口味先跳过</b>
              <span>跳过会记为“未知”，不会自动填成“不挑食”。</span>
            </div>
          </div>
          <div className="sticky-action">
            <button
              className="primary-button"
              disabled={!hardConstraintConfirmed}
              onClick={() => navigate("o03")}
              type="button"
            >
              保存并继续
            </button>
          </div>
        </>
      );
    }

    if (screen === "o03") {
      return (
        <>
          <PrototypeHeader
            eyebrow="首次设置"
            onBack={() => navigate("o02")}
            title="谁来做、能用什么？"
          />
          <div className="screen-body">
            <ProgressDots current={3} />
            <section className="intro-copy">
              <h1>只推荐真正能做的菜</h1>
              <p>难度按本餐厨师判断；缺少必需设备的菜不会进入可执行方案。</p>
            </section>
            <section className="field-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">主要做饭者 · 林然</span>
                  <h2>厨艺水平</h2>
                </div>
              </div>
              <div className="choice-grid three">
                {["刚开始", "家常熟练", "复杂菜也行"].map((value) => (
                  <ChoiceChip
                    active={skill === value}
                    key={value}
                    onClick={() => setSkill(value)}
                  >
                    {value}
                  </ChoiceChip>
                ))}
              </div>
            </section>
            <section className="field-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">家里已有</span>
                  <h2>厨房设备</h2>
                </div>
                <span className="muted-count">{equipment.length} 项</span>
              </div>
              <div className="choice-grid two">
                {["炒锅", "汤锅", "电饭煲", "烤箱", "空气炸锅", "微波炉"].map(
                  (value) => (
                    <ChoiceChip
                      active={equipment.includes(value)}
                      key={value}
                      onClick={() =>
                        toggleListValue(value, equipment, setEquipment)
                      }
                    >
                      {value}
                    </ChoiceChip>
                  ),
                )}
              </div>
            </section>
            <div className="unknown-note">
              <b>以后可随时修改</b>
              <span>本轮不要求填写不常用的技巧和设备型号。</span>
            </div>
          </div>
          <div className="sticky-action split">
            <button
              className="secondary-button"
              onClick={() => navigate("o04")}
              type="button"
            >
              跳过
            </button>
            <button
              className="primary-button"
              onClick={() => navigate("o04")}
              type="button"
            >
              保存并继续
            </button>
          </div>
        </>
      );
    }

    if (screen === "o04") {
      return (
        <>
          <PrototypeHeader
            eyebrow="首次设置"
            onBack={() => navigate("o03")}
            title="常备调味品"
          />
          <div className="screen-body">
            <ProgressDots current={4} />
            <section className="intro-copy">
              <h1>用一个模板快速开始</h1>
              <p>这里只记录“有 / 快没了 / 没有”。没选中的项目仍然是未知。</p>
            </section>
            <button
              className="template-card"
              onClick={() =>
                setPantry(["食用油", "盐", "酱油", "醋", "白糖", "淀粉"])
              }
              type="button"
            >
              <span className="template-mark">常</span>
              <span>
                <strong>中式家常基础组</strong>
                <small>油、盐、酱油、醋、白糖、淀粉</small>
              </span>
              <b>一键选择</b>
            </button>
            <div className="pantry-list">
              {[
                "食用油",
                "盐",
                "酱油",
                "醋",
                "白糖",
                "淀粉",
                "香油",
                "黑胡椒",
              ].map((value) => (
                <label className="status-row" key={value}>
                  <input
                    checked={pantry.includes(value)}
                    onChange={() => toggleListValue(value, pantry, setPantry)}
                    type="checkbox"
                  />
                  <span>{value}</span>
                  <small>{pantry.includes(value) ? "有" : "未知"}</small>
                </label>
              ))}
            </div>
            <div className="unknown-note">
              <b>未知 ≠ 没有</b>
              <span>推荐会把未确认的调味品作为假设展示，不会直接加入缺货清单。</span>
            </div>
          </div>
          <div className="sticky-action split">
            <button
              className="secondary-button"
              onClick={() => navigate("o05")}
              type="button"
            >
              全部跳过
            </button>
            <button
              className="primary-button"
              onClick={() => navigate("o05")}
              type="button"
            >
              已选 {pantry.length} 项，继续
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <PrototypeHeader
          eyebrow="首次设置"
          onBack={() => navigate("o04")}
          title="先加几样确定有的"
        />
        <div className="screen-body">
          <ProgressDots current={5} />
          <section className="intro-copy">
            <h1>5 项就足够开始推荐</h1>
            <p>优先添加最想消耗或最确定存在的食材。模糊数量即可，日期可未知。</p>
          </section>
          <div className="search-shell">
            <span>⌕</span>
            <input
              aria-label="搜索并连续添加食材"
              placeholder="搜索食材，添加后可继续输入"
            />
            <button type="button">添加</button>
          </div>
          <section className="quick-add">
            <div className="section-heading compact">
              <h2>最近与常用</h2>
              <button
                onClick={() => setIngredients(suggestedIngredients.slice(0, 5))}
                type="button"
              >
                一键填充 5 项
              </button>
            </div>
            <div className="chip-wrap">
              {suggestedIngredients.map((value) => (
                <ChoiceChip
                  active={ingredients.includes(value)}
                  key={value}
                  onClick={() =>
                    toggleListValue(value, ingredients, setIngredients)
                  }
                  small
                >
                  {ingredients.includes(value) ? "✓ " : "＋ "}
                  {value}
                </ChoiceChip>
              ))}
            </div>
          </section>
          <section className="added-list">
            <div className="section-heading compact">
              <h2>待确认批次</h2>
              <span className="muted-count">{ingredients.length} 项</span>
            </div>
            {ingredients.length === 0 ? (
              <div className="empty-box">
                <b>还没有食材</b>
                <span>从最近项选一个，最少动作就能开始。</span>
              </div>
            ) : (
              ingredients.map((value, index) => (
                <div className="ingredient-row" key={value}>
                  <span className="index-box">{index + 1}</span>
                  <div>
                    <strong>{value}</strong>
                    <small>
                      {value === "鸡蛋"
                        ? "约半盒"
                        : value === "熟米饭"
                          ? "约 2 碗"
                          : "约一份"}{" "}
                      · {value === "熟米饭" ? "冷藏" : "位置待确认"}
                    </small>
                  </div>
                  <button
                    aria-label={`移除${value}`}
                    onClick={() =>
                      setIngredients(
                        ingredients.filter((item) => item !== value),
                      )
                    }
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </section>
          <div className="unknown-note">
            <b>日期和精确重量都可以以后补</b>
            <span>购买日不会被当成生产日；未填写的字段保持未知。</span>
          </div>
        </div>
        <div className="sticky-action">
          <button
            className="primary-button"
            disabled={ingredients.length < 5}
            onClick={() => navigate("h01")}
            type="button"
          >
            {ingredients.length < 5
              ? `再加 ${5 - ingredients.length} 项`
              : `确认 ${ingredients.length} 个批次，去看看菜单`}
          </button>
        </div>
      </>
    );
  };

  const renderHome = () => (
    <>
      <div className="home-topbar">
        <button className="household-switch" type="button">
          <span className="tiny-home">家</span>
          <span>
            <b>{homeName}</b>
            <small>刚刚同步</small>
          </span>
          <i>⌄</i>
        </button>
        <button
          aria-label="打开评审说明"
          className="round-button"
          onClick={() => setReviewOpen(true)}
          type="button"
        >
          ?
        </button>
      </div>
      <div className="screen-body home-body">
        <section className="date-heading">
          <span>7 月 23 日 · 星期四</span>
          <h1>今晚，想吃点什么？</h1>
        </section>
        <section className="attention-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">需要优先处理 · 2 项</span>
              <h2>先看看这些食材</h2>
            </div>
            <button type="button">查看全部</button>
          </div>
          <div className="attention-row">
            <span className="food-placeholder">番</span>
            <div>
              <strong>番茄 · 约 2 个</strong>
              <small>标签日期：明天 · 用户录入</small>
            </div>
            <b>优先</b>
          </div>
          <div className="attention-row">
            <span className="food-placeholder is-dashed">蛋</span>
            <div>
              <strong>鸡蛋 · 约半盒</strong>
              <small>日期未知 · 建议核对包装</small>
            </div>
            <b className="is-unknown">待确认</b>
          </div>
        </section>
        <section className="meal-launch">
          <div className="meal-launch-copy">
            <span className="eyebrow">本餐默认条件</span>
            <h2>2 人 · 林然做饭 · 30 分钟</h2>
            <div className="avatar-stack" aria-label="林然和小北参加">
              <span>林</span>
              <span>北</span>
              <button type="button">＋</button>
            </div>
          </div>
          <button
            className="hero-button"
            onClick={() => navigate("r01")}
            type="button"
          >
            <span>今天吃什么</span>
            <b>→</b>
          </button>
          <button
            className="quick-agent"
            onClick={() => navigate("r01")}
            type="button"
          >
            <span>⌁</span>
            “今晚三个人，30 分钟，尽量少买菜”
            <b>发送</b>
          </button>
          <small className="agent-caption">
            Agent 会先把条件整理成可编辑信息，再开始推荐
          </small>
        </section>
        <section className="resume-card">
          <span className="outline-icon">菜</span>
          <div>
            <span className="eyebrow">上次做过</span>
            <strong>香菇鸡肉焖饭</strong>
            <small>4 天前 · 家庭评价“省事”</small>
          </div>
          <button type="button">再来一次</button>
        </section>
      </div>
      <BottomNav
        active="home"
        onHome={() => navigate("h01")}
        onOutOfScope={showScopeNote}
        onShopping={() => navigate("s01")}
      />
    </>
  );

  const renderMealConditions = () => (
    <>
      <PrototypeHeader
        eyebrow="今天吃什么"
        onBack={() => navigate("h01")}
        title="确认本餐条件"
      />
      <div className="screen-body">
        <div className="parsed-banner">
          <span>⌁</span>
          <div>
            <b>已带入你常用的晚餐设置</b>
            <p>这些条件可以改，修改不会自动变成永久偏好。</p>
          </div>
        </div>
        <section className="field-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">硬约束来源</span>
              <h2>谁参加这顿饭？</h2>
            </div>
            <span className="hard-tag">不可绕过</span>
          </div>
          <div className="person-toggle-row">
            {["林然", "小北", "妈妈"].map((person) => (
              <button
                className={
                  selectedDiners.includes(person) ? "is-selected" : ""
                }
                key={person}
                onClick={() =>
                  toggleListValue(person, selectedDiners, setSelectedDiners)
                }
                type="button"
              >
                <span>{person.slice(-1)}</span>
                <b>{person}</b>
                <small>
                  {person === "小北"
                    ? "花生过敏"
                    : person === "妈妈"
                      ? "今天不在家"
                      : "无已知过敏"}
                </small>
              </button>
            ))}
          </div>
        </section>
        <section className="condition-card">
          <div className="condition-row">
            <span>做饭者</span>
            <button type="button">林然 · {skill}⌄</button>
          </div>
          <div className="condition-group">
            <span>总时间</span>
            <div className="segmented">
              {["20", "30", "45"].map((value) => (
                <button
                  className={timeLimit === value ? "is-active" : ""}
                  key={value}
                  onClick={() => setTimeLimit(value)}
                  type="button"
                >
                  {value} 分钟
                </button>
              ))}
            </div>
          </div>
          <div className="condition-group">
            <span>是否愿意采购</span>
            <div className="segmented">
              {["不买菜", "少量补购", "可以买"].map((value) => (
                <button
                  className={shoppingTolerance === value ? "is-active" : ""}
                  key={value}
                  onClick={() => setShoppingTolerance(value)}
                  type="button"
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="temporary-request">
          <div className="section-heading compact">
            <h2>本次临时需求</h2>
            <span className="soft-tag">只影响这顿</span>
          </div>
          <textarea
            aria-label="本次临时需求"
            defaultValue="清淡一点，优先用掉番茄"
          />
        </section>
        <div className="constraint-summary">
          <b>开始前会校验</b>
          <span>2 位用餐者 · 1 条过敏限制 · 3 件可用设备 · 最新库存</span>
        </div>
      </div>
      <div className="sticky-action">
        <button
          className="primary-button"
          disabled={selectedDiners.length === 0}
          onClick={() => navigate("r02")}
          type="button"
        >
          生成今晚的建议组合
        </button>
      </div>
    </>
  );

  const renderMenuComparison = () => (
    <>
      <PrototypeHeader
        eyebrow="系统建议 + 自由加菜"
        onBack={() => navigate("r01")}
        title={`今晚建议做 ${recommendedDishIds.length} 道`}
        trailing={
          <button className="icon-button" type="button">
            ⋯
          </button>
        }
      />
      <div className="screen-body comparison-body">
        <div className="comparison-intro">
          <span>2 人 · {timeLimit} 分钟 · {shoppingTolerance}</span>
          <button onClick={() => navigate("r01")} type="button">
            修改条件
          </button>
        </div>
        <section className="meal-structure-card">
          <div className="structure-graphic" aria-hidden="true">
            <span>主食</span>
            <i>＋</i>
            <span>蔬菜</span>
          </div>
          <div>
            <span className="eyebrow">建议餐桌结构</span>
            <h2>1 份主食 / 主菜 + 1 份蔬菜</h2>
            <p>默认选好 2 道；想丰盛一点，可再加 1 道。</p>
          </div>
        </section>

        <section className="dish-section" aria-label="系统建议的菜">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">系统建议 · 已预选</span>
              <h2>先做这 {recommendedDishIds.length} 道</h2>
            </div>
            <span className="soft-tag">可移除</span>
          </div>
          <div className="dish-stack">
            {dishOptions
              .filter((dish) => dish.recommended)
              .map((dish) => {
                const selected = selectedDishIds.includes(dish.id);
                return (
                  <button
                    aria-label={`${selected ? "移除" : "加入"} ${dish.title}`}
                    aria-pressed={selected}
                    className={`dish-select-card ${selected ? "is-selected" : ""}`}
                    key={dish.id}
                    onClick={() => toggleDish(dish.id)}
                    type="button"
                  >
                    <span className="dish-card-mark">
                      {selected ? "✓" : "＋"}
                    </span>
                    <span className="dish-card-copy">
                      <span className="dish-card-top">
                        <i>{dish.category}</i>
                        <strong>{dish.title}</strong>
                      </span>
                      <small>{dish.summary}</small>
                      <span className="dish-card-meta">
                        {dish.minutes} 分钟 · 缺 {dish.missing.length} 项 ·
                        库存 {dish.coverage}%
                      </span>
                      <em>{dish.reason}</em>
                    </span>
                  </button>
                );
              })}
          </div>
        </section>

        <section className="dish-section" aria-label="可选的菜">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">可选菜 · 按需增减</span>
              <h2>
                {selectedDishIds.length < 3
                  ? `还可以加 ${3 - selectedDishIds.length} 道`
                  : "已到 3 道上限"}
              </h2>
            </div>
            <span className="muted-count">点击多选</span>
          </div>
          <div className="dish-stack optional-dishes">
            {dishOptions
              .filter((dish) => !dish.recommended)
              .map((dish) => {
                const selected = selectedDishIds.includes(dish.id);
                return (
                  <button
                    aria-label={`${selected ? "移除" : "加入"} ${dish.title}`}
                    aria-pressed={selected}
                    className={`dish-select-card is-optional ${selected ? "is-selected" : ""}`}
                    key={dish.id}
                    onClick={() => toggleDish(dish.id)}
                    type="button"
                  >
                    <span className="dish-card-mark">
                      {selected ? "✓" : "＋"}
                    </span>
                    <span className="dish-card-copy">
                      <span className="dish-card-top">
                        <i>{dish.category}</i>
                        <strong>{dish.title}</strong>
                      </span>
                      <small>{dish.summary}</small>
                      <span className="dish-card-meta">
                        {dish.minutes} 分钟 · 缺 {dish.missing.length} 项 ·
                        库存 {dish.coverage}%
                      </span>
                      <em>{dish.reason}</em>
                    </span>
                  </button>
                );
              })}
          </div>
        </section>

        <section className="meal-selection-summary" aria-live="polite">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">本餐实时汇总</span>
              <h2>已选 {selectedDishIds.length} 道</h2>
            </div>
            <span className="plan-number">{selectedDishIds.length}/3</span>
          </div>
          <p className="selection-names">
            {selectedDishes.map((dish) => dish.title).join(" · ")}
          </p>
          <div className="selection-stats">
            <span>
              <small>总时间</small>
              <b>{selectedMenu.time}</b>
            </span>
            <span>
              <small>需购买</small>
              <b>{selectedMenu.missing.length} 项</b>
            </span>
            <span>
              <small>库存覆盖</small>
              <b>{selectedMenu.coverage}</b>
            </span>
          </div>
          <div className="assumption-line">
            <b>动态估算</b>
            <span>每次增减都会重算整餐时间、采购项与库存消耗。</span>
          </div>
        </section>

        <button
          className="reroll-button"
          onClick={() => navigate("r01")}
          type="button"
        >
          这些菜都不合适 · 改条件再推荐
        </button>
      </div>
      <div className="sticky-action">
        <button
          className="primary-button"
          onClick={() => navigate("r03")}
          type="button"
        >
          查看已选的 {selectedDishIds.length} 道菜
        </button>
      </div>
    </>
  );

  const renderMenuDetail = () => (
    <>
      <PrototypeHeader
        eyebrow={selectedMenu.objective}
        onBack={() => navigate("r02")}
        title={selectedMenu.title}
        trailing={
          <button className="icon-button" type="button">
            ☆
          </button>
        }
      />
      <div className="screen-body">
        <section className="menu-wire-hero">
          <div className="plate-wire">
            <span />
            <span />
            <span />
          </div>
          <div className="menu-wire-caption">
            <b>{selectedMenu.dishes}</b>
            <span>2 人份 · {selectedMenu.equipment}</span>
          </div>
        </section>
        <div className="stat-strip">
          <div>
            <span>总时间</span>
            <b>{selectedMenu.time}</b>
          </div>
          <div>
            <span>动手</span>
            <b>{selectedMenu.active}</b>
          </div>
          <div>
            <span>难度</span>
            <b>{selectedMenu.difficulty}</b>
          </div>
        </div>
        <section className="latest-check">
          <div>
            <span className="check-mark">✓</span>
            <div>
              <b>刚刚通过最新校验</b>
              <small>2 位用餐者 · 花生过敏已排除 · 库存版本 14:32</small>
            </div>
          </div>
          <button type="button">查看依据</button>
        </section>
        <section className="detail-section">
          <div className="section-heading compact">
            <h2>食材准备</h2>
            <span className="muted-count">
              缺少 {selectedMenu.missing.length} 项
            </span>
          </div>
          <div className="ingredient-status-columns">
            <div>
              <span className="eyebrow">家里已有</span>
              {selectedMenu.uses.map((item) => (
                <p key={item}>
                  <i>✓</i>
                  {item}
                </p>
              ))}
            </div>
            <div>
              <span className="eyebrow">需要补购</span>
              {selectedMenu.missing.map((item) => (
                <p key={item}>
                  <i>＋</i>
                  {item}
                </p>
              ))}
            </div>
          </div>
        </section>
        <section className="detail-section">
          <div className="section-heading compact">
            <h2>步骤预览</h2>
            <span className="muted-count">{selectedMenu.cookSteps.length} 步</span>
          </div>
          {selectedMenu.cookSteps.map((step, index) => (
            <div className="step-preview" key={step.title}>
              <span>{index + 1}</span>
              <div>
                <b>{step.title}</b>
                <small>{step.detail}</small>
              </div>
            </div>
          ))}
        </section>
        <div className="safety-note">
          <b>安全提醒</b>
          <span>
            本菜单已排除花生；涉及生肉或鸡蛋时，原型不会用外观替代熟度判断。
          </span>
        </div>
        <div className="assumption-line">
          <b>关键假设</b>
          <span>{selectedMenu.assumption}</span>
        </div>
      </div>
      <div className="sticky-action">
        <button className="primary-button" onClick={confirmMenu} type="button">
          确认 {selectedDishIds.length} 道菜 · 加入{" "}
          {selectedMenu.missing.length} 项采购
        </button>
      </div>
    </>
  );

  const renderShopping = () => (
    <>
      <div className="shopping-topbar">
        <div>
          <span className="eyebrow">共享清单</span>
          <h1>采购</h1>
        </div>
        <div className="shopping-avatars">
          <span>林</span>
          <span>北</span>
          <i>在线</i>
        </div>
      </div>
      <div className="screen-body shopping-body">
        <div className="sync-line">
          <span className="sync-dot" />
          家庭清单已同步 · 刚刚
        </div>
        <section className="shopping-summary">
          <div>
            <span>待购买</span>
            <b>{shoppingItems.length - purchasedCount}</b>
          </div>
          <div>
            <span>已买待入库</span>
            <b>{purchasedCount}</b>
          </div>
          <button onClick={simulateAllPurchased} type="button">
            模拟全部买到
          </button>
        </section>
        <div className="add-shopping-row">
          <input aria-label="手动添加采购项" placeholder="＋ 添加其他要买的" />
          <button type="button">添加</button>
        </div>
        <section className="shopping-section">
          <div className="section-heading compact">
            <h2>当前清单</h2>
            <button type="button">按类别⌄</button>
          </div>
          {shoppingItems.map((item) => (
            <label
              className={`shopping-row ${item.purchased ? "is-purchased" : ""}`}
              key={item.id}
            >
              <input
                checked={item.purchased}
                onChange={() => updateShoppingItem(item.id)}
                type="checkbox"
              />
              <span className="shopping-check">
                {item.purchased ? "✓" : ""}
              </span>
              <span className="shopping-copy">
                <strong>{item.name}</strong>
                <small>
                  {item.quantity} · 来源：{item.source}
                </small>
                {item.actor && <em>{item.actor}</em>}
              </span>
              <button aria-label={`编辑${item.name}`} type="button">
                ⋯
              </button>
            </label>
          ))}
        </section>
        <div className="state-explainer">
          <div>
            <span className="state-dot is-current" />
            <b>待购买</b>
          </div>
          <i>→</i>
          <div>
            <span className="state-dot" />
            <b>已买待入库</b>
          </div>
          <i>→</i>
          <div>
            <span className="state-dot" />
            <b>已入库</b>
          </div>
        </div>
        <p className="micro-copy">
          勾选“已买”不会猜测数量和日期，也不会直接增加库存。
        </p>
        {purchasedCount > 0 && (
          <button
            className="pending-inventory-card"
            onClick={() => navigate("s02")}
            type="button"
          >
            <span className="outline-icon">入</span>
            <span>
              <b>{purchasedCount} 项已买，等待回家入库</b>
              <small>现在可以继续购物，不必立刻补信息</small>
            </span>
            <i>→</i>
          </button>
        )}
      </div>
      <BottomNav
        active="shopping"
        onHome={() => navigate("h01")}
        onOutOfScope={showScopeNote}
        onShopping={() => navigate("s01")}
      />
    </>
  );

  const renderPendingInventory = () => (
    <>
      <PrototypeHeader
        eyebrow="采购 → 库存"
        onBack={() => navigate("s01")}
        title="确认买回来的食材"
      />
      <div className="screen-body">
        <div className="parsed-banner neutral">
          <span>{inventoryRows.length}</span>
          <div>
            <b>只补最必要的信息</b>
            <p>本次会创建新批次，不覆盖家中已有的同名食材。</p>
          </div>
        </div>
        {inventoryRows.length === 0 ? (
          <div className="empty-box tall">
            <b>还没有已买项目</b>
            <span>回到共享清单勾选“已买”，项目才会进入这里。</span>
            <button onClick={() => navigate("s01")} type="button">
              返回采购清单
            </button>
          </div>
        ) : (
          <section className="pending-list">
            {inventoryRows.map((item) => (
              <article className="pending-card" key={item.id}>
                <div className="pending-title">
                  <span className="outline-icon">{item.name.slice(0, 1)}</span>
                  <div>
                    <strong>{item.name}</strong>
                    <small>来源：共享采购 · {item.actor}</small>
                  </div>
                  <button type="button">编辑</button>
                </div>
                <div className="batch-fields">
                  <button type="button">
                    <span>数量</span>
                    <b>{item.quantity || "约一份"}</b>
                    <i>⌄</i>
                  </button>
                  <button type="button">
                    <span>位置</span>
                    <b>{item.name === "厨房纸" ? "常温" : "冷藏"}</b>
                    <i>⌄</i>
                  </button>
                </div>
                <div className="date-source-row">
                  <span>
                    购买日 <b>今天</b>
                    <em>用户输入</em>
                  </span>
                  <button type="button">其他日期未知</button>
                </div>
              </article>
            ))}
          </section>
        )}
        <label className="check-row standalone">
          <input defaultChecked type="checkbox" />
          <span>
            <b>使用相同位置和购买日</b>
            <small>仍会为每项创建独立批次和购入事件</small>
          </span>
        </label>
        <div className="unknown-note">
          <b>包装日期看不清可以留空</b>
          <span>购买日不会被替代为生产日；未知信息不会由模型补造。</span>
        </div>
        {inventoryConfirmed && (
          <div className="success-banner">
            <span>✓</span>
            <div>
              <b>已创建 {inventoryRows.length} 个库存批次</b>
              <small>采购状态已更新为“已入库”</small>
            </div>
          </div>
        )}
      </div>
      <div className="sticky-action">
        {inventoryConfirmed ? (
          <button
            className="primary-button"
            onClick={() => navigate("c01")}
            type="button"
          >
            回到菜单，准备做饭
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={inventoryRows.length === 0}
            onClick={() => setInventoryConfirmed(true)}
            type="button"
          >
            确认入库 {inventoryRows.length} 项
          </button>
        )}
      </div>
    </>
  );

  const renderPreCook = () => (
    <>
      <PrototypeHeader
        eyebrow="开始前检查"
        onBack={() => navigate(inventoryConfirmed ? "s02" : "r03")}
        title={selectedMenu.title}
      />
      <div className="screen-body">
        <section className="preflight-status">
          <span className="big-check">✓</span>
          <div>
            <span className="eyebrow">14:41 · 已重新校验</span>
            <h1>可以开始做饭</h1>
            <p>参与者、硬约束和库存都已使用最新版本检查。</p>
          </div>
        </section>
        <div className="preflight-grid">
          <div>
            <span>参与人数</span>
            <b>{selectedDiners.length || 2} 人</b>
          </div>
          <div>
            <span>预计完成</span>
            <b>{selectedMenu.time}</b>
          </div>
          <div>
            <span>必需设备</span>
            <b>{selectedMenu.equipment}</b>
          </div>
          <div>
            <span>缺少食材</span>
            <b className={inventoryConfirmed ? "ok-text" : ""}>
              {inventoryConfirmed ? "0 项" : `${selectedMenu.missing.length} 项`}
            </b>
          </div>
        </div>
        {!inventoryConfirmed && (
          <div className="warning-banner">
            <b>原型跳转提示</b>
            <span>
              采购项还未确认入库。正式产品会阻止开始；可先回采购，或使用评审目录继续看流程。
            </span>
            <button onClick={() => navigate("s01")} type="button">
              去采购确认
            </button>
          </div>
        )}
        <section className="checklist">
          <div className="section-heading compact">
            <h2>开火前准备</h2>
            <span className="muted-count">3 项</span>
          </div>
          {[
            "清洗蔬菜并准备两块砧板",
            "从冷藏取出本餐食材",
            "确认炒锅与汤锅可以同时使用",
          ].map((item) => (
            <label className="check-row simple" key={item}>
              <input defaultChecked type="checkbox" />
              <span>{item}</span>
            </label>
          ))}
        </section>
        <div className="safety-note strong">
          <b>本餐关键安全点</b>
          <span>
            {selectedMenu.cookSteps.find((step) => step.safety)?.safety ??
              "按步骤完成加热，不用模型判断食材是否安全。"}
          </span>
        </div>
        <button className="download-steps" type="button">
          离线保存本餐步骤 <span>可暂停恢复</span>
        </button>
      </div>
      <div className="sticky-action">
        <button
          className="primary-button"
          onClick={() => {
            setCookStep(0);
            navigate("c02");
          }}
          type="button"
        >
          开始做饭
        </button>
      </div>
    </>
  );

  const renderCooking = () => {
    const currentStep = selectedMenu.cookSteps[cookStep];
    return (
      <>
        <PrototypeHeader
          eyebrow={`${selectedMenu.title} · 做饭中`}
          onBack={() => navigate("c01")}
          title={`步骤 ${cookStep + 1}/${selectedMenu.cookSteps.length}`}
          trailing={
            <button className="icon-button" type="button">
              暂停
            </button>
          }
        />
        <div className="cook-progress">
          {selectedMenu.cookSteps.map((_, index) => (
            <span
              className={index <= cookStep ? "is-done" : ""}
              key={index}
            />
          ))}
        </div>
        <div className="screen-body cook-body">
          <div className="cook-step-number">{cookStep + 1}</div>
          <section className="current-step">
            <span className="eyebrow">现在做</span>
            <h1>{currentStep.title}</h1>
            <p>{currentStep.detail}</p>
          </section>
          <div className="ingredient-callout">
            <b>本步用量</b>
            <span>
              {selectedMenu.uses.slice(0, 2).join(" · ") || "按菜单份量准备"}
            </span>
          </div>
          <div className="timer-wire">
            <div>
              <span>建议计时</span>
              <b>{cookStep === 1 ? "06:00" : "03:00"}</b>
            </div>
            <button type="button">开始计时</button>
          </div>
          {currentStep.safety && (
            <div className="safety-note strong">
              <b>做到这里请注意</b>
              <span>{currentStep.safety}</span>
            </div>
          )}
          <button className="agent-question" type="button">
            <span>⌁</span>
            问当前步骤：“火候怎么判断？”
            <b>→</b>
          </button>
          <p className="micro-copy center">
            Agent 可以解释当前步骤，但不能跳过食品安全提示。
          </p>
        </div>
        <div className="sticky-action split">
          <button
            className="secondary-button"
            disabled={cookStep === 0}
            onClick={() => setCookStep((value) => Math.max(0, value - 1))}
            type="button"
          >
            上一步
          </button>
          {cookStep < selectedMenu.cookSteps.length - 1 ? (
            <button
              className="primary-button"
              onClick={() => setCookStep((value) => value + 1)}
              type="button"
            >
              完成这步，继续
            </button>
          ) : (
            <button
              className="primary-button"
              onClick={() => navigate("c03")}
              type="button"
            >
              做完了
            </button>
          )}
        </div>
      </>
    );
  };

  const renderCompletionState = () => (
    <>
      <PrototypeHeader
        eyebrow="结束本次做饭"
        onBack={() => navigate("c02")}
        title="实际做了多少？"
      />
      <div className="screen-body completion-body">
        <div className="completion-wire" aria-hidden="true">
          <span>完</span>
        </div>
        <section className="intro-copy centered">
          <h1>先确认完成状态</h1>
          <p>
            这一步只决定后续如何估算消耗。库存还没有扣减，下一页仍可逐项修改。
          </p>
        </section>
        <div className="completion-options">
          {[
            {
              id: "all" as const,
              title: "全部完成",
              text: "按菜单份量预填预计消耗",
              mark: "100%",
            },
            {
              id: "partial" as const,
              title: "只做了一部分",
              text: "保留菜品，逐项核对实际用量",
              mark: "部分",
            },
            {
              id: "none" as const,
              title: "没有做",
              text: "不扣库存，可记录中止原因",
              mark: "0%",
            },
          ].map((option) => (
            <button
              aria-pressed={completionState === option.id}
              className={
                completionState === option.id ? "is-selected" : ""
              }
              key={option.id}
              onClick={() => setCompletionState(option.id)}
              type="button"
            >
              <span>{option.mark}</span>
              <div>
                <b>{option.title}</b>
                <small>{option.text}</small>
              </div>
              <i>{completionState === option.id ? "●" : "○"}</i>
            </button>
          ))}
        </div>
        <div className="process-note">
          <b>当前还不会发生</b>
          <span>不会自动扣库存 · 不会自动保存剩菜 · 不会把临时反馈变成硬约束</span>
        </div>
      </div>
      <div className="sticky-action">
        <button
          className="primary-button"
          onClick={() =>
            completionState === "none" ? navigate("c05") : navigate("c04")
          }
          type="button"
        >
          {completionState === "none" ? "确认没有做" : "下一步：核对实际消耗"}
        </button>
      </div>
    </>
  );

  const renderDeduction = () => (
    <>
      <PrototypeHeader
        eyebrow={completionState === "partial" ? "部分完成" : "全部完成"}
        onBack={() => navigate("c03")}
        title="核对实际消耗"
      />
      <div className="screen-body deduction-body">
        <div className="write-warning">
          <span>!</span>
          <div>
            <b>确认后才会写入库存消耗事件</b>
            <p>预计值来自本次菜单；可调整、排除或标记待盘点。</p>
          </div>
        </div>
        {conflict ? (
          <div className="conflict-banner">
            <div>
              <span>↻</span>
              <div>
                <b>库存刚被小北更新</b>
                <p>上海青剩余量已变为约半袋，系统已按最新批次重算。</p>
              </div>
            </div>
            <small>不会产生负库存；无法确定的部分将标记待盘点。</small>
          </div>
        ) : (
          <button
            className="simulate-conflict"
            onClick={() => {
              setConflict(true);
              if (
                selectedMenu.deductions.some((item) => item.id === "greens")
              ) {
                setDeductionAmounts((current) => ({
                  ...current,
                  greens: 0.5,
                }));
              }
            }}
            type="button"
          >
            评审工具：模拟家人刚更新库存
          </button>
        )}
        <section className="deduction-list">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">预计使用的具体批次</span>
              <h2>{selectedMenu.deductions.length} 项食材</h2>
            </div>
            <button
              onClick={() =>
                setIncludedDeductions(
                  Object.fromEntries(
                    dishOptions.flatMap((dish) =>
                      dish.deductions.map((item) => [item.id, true]),
                    ),
                  ),
                )
              }
              type="button"
            >
              全选
            </button>
          </div>
          {selectedMenu.deductions.map((item) => {
            const included = includedDeductions[item.id];
            const step = item.amount < 1 ? 0.1 : 1;
            return (
              <article
                className={`deduction-card ${included ? "" : "is-excluded"}`}
                key={item.id}
              >
                <label className="deduction-title">
                  <input
                    checked={included}
                    onChange={(event) =>
                      setIncludedDeductions((current) => ({
                        ...current,
                        [item.id]: event.target.checked,
                      }))
                    }
                    type="checkbox"
                  />
                  <span className="shopping-check">{included ? "✓" : ""}</span>
                  <span>
                    <b>{item.name}</b>
                    <small>{item.batch}</small>
                  </span>
                  <em>{included ? "会扣减" : "不使用"}</em>
                </label>
                {included && (
                  <div className="amount-editor">
                    <span>实际使用</span>
                    <div>
                      <button
                        aria-label={`减少${item.name}用量`}
                        onClick={() => adjustDeduction(item.id, -step)}
                        type="button"
                      >
                        −
                      </button>
                      <b>
                        {deductionAmounts[item.id]} {item.unit}
                      </b>
                      <button
                        aria-label={`增加${item.name}用量`}
                        onClick={() => adjustDeduction(item.id, step)}
                        type="button"
                      >
                        ＋
                      </button>
                    </div>
                    <button className="fuzzy-link" type="button">
                      数量不准
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
        <section className={`leftover-card ${leftover ? "is-selected" : ""}`}>
          <label>
            <input
              checked={leftover}
              onChange={(event) => setLeftover(event.target.checked)}
              type="checkbox"
            />
            <span>
              <b>把剩菜保存为新批次</b>
              <small>熟食需要重新记录制作时间、数量和储存位置</small>
            </span>
          </label>
          {leftover && (
            <div className="leftover-fields">
              <button type="button">
                <span>数量</span>
                <b>约 1 盒⌄</b>
              </button>
              <button type="button">
                <span>位置</span>
                <b>冷藏⌄</b>
              </button>
              <p>制作时间：今天 19:12 · 系统记录</p>
            </div>
          )}
        </section>
        <div className="event-summary">
          <span>本次将写入</span>
          <b>
            {
              selectedMenu.deductions.filter(
                (item) => includedDeductions[item.id],
              ).length
            }{" "}
            条消耗事件
            {leftover ? " · 1 个剩菜批次" : ""}
          </b>
        </div>
      </div>
      <div className="sticky-action">
        <button
          className="primary-button"
          onClick={() => navigate("c05")}
          type="button"
        >
          确认扣减并完成本餐
        </button>
      </div>
    </>
  );

  const renderReceipt = () => {
    const includedRows = selectedMenu.deductions.filter(
      (item) => includedDeductions[item.id],
    );
    return (
      <>
        <PrototypeHeader
          eyebrow="本餐已完成"
          title="记录成功"
          trailing={
            <button
              className="icon-button"
              onClick={() => navigate("h01")}
              type="button"
            >
              ×
            </button>
          }
        />
        <div className="screen-body receipt-body">
          <div className="receipt-check">✓</div>
          <section className="intro-copy centered">
            <h1>{selectedMenu.title}，完成</h1>
            <p>库存与剩菜都已按你的确认记录，可从操作历史纠正。</p>
          </section>
          {completionState === "none" ? (
            <div className="receipt-card">
              <div className="receipt-title">
                <span>0</span>
                <div>
                  <b>没有写入库存消耗</b>
                  <small>本餐记录为“没有做”</small>
                </div>
              </div>
            </div>
          ) : (
            <div className="receipt-card">
              <div className="receipt-title">
                <span>{includedRows.length}</span>
                <div>
                  <b>库存消耗事件已写入</b>
                  <small>今天 19:13 · 操作者：林然</small>
                </div>
                <button type="button">纠正</button>
              </div>
              <div className="receipt-lines">
                {includedRows.slice(0, 4).map((item) => (
                  <p key={item.id}>
                    <span>{item.name}</span>
                    <b>
                      − {deductionAmounts[item.id]} {item.unit}
                    </b>
                  </p>
                ))}
                {includedRows.length > 4 && (
                  <small>另有 {includedRows.length - 4} 项</small>
                )}
              </div>
            </div>
          )}
          {leftover && completionState !== "none" && (
            <div className="receipt-card leftover-receipt">
              <div className="receipt-title">
                <span>＋</span>
                <div>
                  <b>{selectedMenu.title}剩菜 · 约 1 盒</b>
                  <small>新批次 · 冷藏 · 制作于今天 19:12</small>
                </div>
                <button type="button">查看</button>
              </div>
            </div>
          )}
          <section className="feedback-section">
            <div className="section-heading compact">
              <div>
                <span className="eyebrow">可选 · 只影响软偏好</span>
                <h2>这顿饭怎么样？</h2>
              </div>
              <button type="button">跳过</button>
            </div>
            <div className="chip-wrap">
              {["喜欢", "不喜欢", "太难", "太慢", "刚刚好"].map((value) => (
                <ChoiceChip
                  active={feedback.includes(value)}
                  key={value}
                  onClick={() => toggleListValue(value, feedback, setFeedback)}
                  small
                >
                  {value}
                </ChoiceChip>
              ))}
            </div>
          </section>
          <div className="process-note">
            <b>完整闭环</b>
            <span>
              菜单已完成 → 消耗已确认 → 库存已更新 → 剩菜已形成新批次
            </span>
          </div>
        </div>
        <div className="sticky-action">
          <button
            className="primary-button"
            onClick={() => navigate("h01")}
            type="button"
          >
            回到今天
          </button>
        </div>
      </>
    );
  };

  const renderScreen = () => {
    if (screen.startsWith("o")) return renderOnboarding();
    if (screen === "h01") return renderHome();
    if (screen === "r01") return renderMealConditions();
    if (screen === "r02") return renderMenuComparison();
    if (screen === "r03") return renderMenuDetail();
    if (screen === "s01") return renderShopping();
    if (screen === "s02") return renderPendingInventory();
    if (screen === "c01") return renderPreCook();
    if (screen === "c02") return renderCooking();
    if (screen === "c03") return renderCompletionState();
    if (screen === "c04") return renderDeduction();
    return renderReceipt();
  };

  return (
    <main className="review-canvas">
      <header className="review-topbar">
        <div className="prototype-brand">
          <span>MA</span>
          <div>
            <b>Meal Agent</b>
            <small>可评审低保真原型 · v0.2</small>
          </div>
        </div>
        <div className="review-legend">
          <span>
            <i className="legend-solid" /> 已确认基线
          </span>
          <span>
            <i className="legend-dashed" /> 待验证假设
          </span>
        </div>
        <button
          className="mobile-review-button"
          onClick={() => setReviewOpen(true)}
          type="button"
        >
          页面与验证点
        </button>
      </header>

      <div className="review-layout">
        <aside className={`review-sidebar ${reviewOpen ? "is-open" : ""}`}>
          <div className="sidebar-mobile-head">
            <b>原型目录与验证点</b>
            <button onClick={() => setReviewOpen(false)} type="button">
              ×
            </button>
          </div>
          <div className="sidebar-scroll">
            <section className="validation-card">
              <span className="eyebrow">当前页面 · {currentMeta.code}</span>
              <h2>{currentMeta.title}</h2>
              <p>
                核心风险：<b>{currentMeta.risk}</b>
              </p>
              <ul>
                {currentMeta.observe.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <nav className="page-index" aria-label="原型页面目录">
              {pageGroups.map((group) => (
                <div key={group.title}>
                  <h3>{group.title}</h3>
                  {group.pages.map((page) => (
                    <button
                      className={screen === page.id ? "is-active" : ""}
                      key={page.id}
                      onClick={() => navigate(page.id)}
                      type="button"
                    >
                      <span>{page.code}</span>
                      <b>{page.label}</b>
                      <i>→</i>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <section className="review-task">
              <span className="eyebrow">重点评审任务</span>
              <ol>
                <li>不填精确数量，完成 5 项食材录入</li>
                <li>20 秒内理解建议数量并增减一道可选菜</li>
                <li>把采购项从“已买”确认到“已入库”</li>
                <li>部分完成：调整鸡蛋、排除小葱、保存剩菜</li>
                <li>模拟库存冲突并解释重算结果</li>
              </ol>
            </section>
            <button
              className="reset-button"
              onClick={resetPrototype}
              type="button"
            >
              ↻ 重置所有演示状态
            </button>
          </div>
        </aside>

        {reviewOpen && (
          <button
            aria-label="关闭评审面板"
            className="sidebar-backdrop"
            onClick={() => setReviewOpen(false)}
            type="button"
          />
        )}

        <section className="prototype-stage">
          <div className="stage-note">
            <span>微信小程序优先 · 390 × 844 参考视口</span>
            <b>{currentMeta.code}</b>
          </div>
          <div className="phone-shell">
            <div className="phone-statusbar" aria-hidden="true">
              <b>19:08</b>
              <span>◒ ᯤ ▰</span>
            </div>
            {toast && (
              <div className="prototype-toast">
                <span>{toast}</span>
                <button onClick={() => setToast("")} type="button">
                  ×
                </button>
              </div>
            )}
            <div className="phone-content" ref={contentRef}>
              {renderScreen()}
            </div>
          </div>
        </section>

        <aside className="review-notes">
          <section>
            <span className="eyebrow">验证目标</span>
            <h2>少填、快比、可确认</h2>
            <div className="risk-meter">
              <span>录入成本</span>
              <b>2 分钟</b>
              <i>
                <em style={{ width: screen.startsWith("o") ? "65%" : "30%" }} />
              </i>
              <small>5 项食材，不要求精确重量和日期</small>
            </div>
            <div className="risk-meter">
              <span>组合选择</span>
              <b>20 秒</b>
              <i>
                <em style={{ width: screen === "r02" ? "80%" : "35%" }} />
              </i>
              <small>看懂建议数量，能增减菜并解释整餐变化</small>
            </div>
            <div className="risk-meter">
              <span>餐后扣减</span>
              <b>45 秒</b>
              <i>
                <em
                  style={{
                    width: ["c03", "c04", "c05"].includes(screen)
                      ? "75%"
                      : "25%",
                  }}
                />
              </i>
              <small>看懂具体批次，能调整、排除与回库</small>
            </div>
          </section>
          <section className="assumption-note">
            <span className="eyebrow">原型说明</span>
            <p>
              示例家庭、库存和日期均为虚构。多人同步、库存校验和事件写入由本地状态模拟，不代表正式技术方案。
            </p>
          </section>
          <section className="decision-note">
            <span className="eyebrow">请特别留意</span>
            <p>“已买”与“已入库”是否清楚？</p>
            <p>“做完”后再确认扣减是否显得重复？</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
