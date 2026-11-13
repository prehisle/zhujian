// 捕获浮窗的斜杠命令(/space /task /tag)——内联建议面板,注册表驱动、单一真相源。
//
// 触发词用英文当稳定 id(i18n:命令词不随语言变,面板显示的 label/hint 走本地化);
// 且打 `/` 时本就在英文输入态,`/task` 顺手,`/任务` 反而要切输入法。
//
// 非承诺式(解决 `/` 转义冲突):输入首行以 `/` 开头**且**有命令匹配才亮面板;像
// 「/etc/hosts 要改」这种打到 /etc 没命令匹配,面板不亮,回车照旧存为记录——命令
// 模式绝不吞掉正文里正常的斜杠。Esc 主动关面板 = 「我就是要写字面斜杠」,在把 `/`
// 删掉前不再自动弹回。
//
// 命令两类,行为差在「首行余下当什么」:
//   - 修饰·取参(takesArg,如 /tag 家庭):余下整行 = 参数(标签名),消费掉不留正文。
//   - 动作 / 修饰·不取参(/space、/task):余下留作正文(/task 买牛奶 → 正文「买牛奶」)。
// 本控制器只管「面板 UI + 键处理 + 解析」;具体做什么由 onExec 回调决定。

export type CommandDef = {
  /** 稳定英文触发词(打 /id);也是 onExec 回传的标识。 */
  id: string;
  /** 面板显示名(可本地化)。 */
  label: string;
  /** 右侧一句说明。 */
  hint: string;
  /** true = 首行余下当参数消费(/tag 家庭);false = 余下留作正文(/task 买牛奶)。 */
  takesArg: boolean;
  /** 动态可用(如 /space 仅 ≥2 空间才给);缺省恒可用。 */
  enabled?: () => boolean;
  /** 取参命令的候选(902 E5):命令词打全、后面已有参数时问一次,返回的每一项在命令那一行下面各占一行,
   *  ↑↓ + 回车 / 点选 = 拿这一项当参数执行(`/tag 家` → 已有的「家里」)。不选、直接回车 = 照旧拿打的字执行。 */
  argOptions?: (arg: string) => string[];
};

/** 候选最多列几行(纸条窗高有上限,列多了把正文挤没)。 */
const MAX_OPTIONS = 6;

export type CaptureCommands = {
  /** 输入变化后重算匹配、刷新面板(main.ts 的 input 监听里调,随后自行量窗)。 */
  refresh(): void;
  /** 键处理:面板开着时吃掉 ↑↓/Enter/Tab/Esc,返回 true=已消费(caller 别再当保存/收窗)。 */
  handleKey(e: KeyboardEvent): boolean;
  isOpen(): boolean;
};

export function createCaptureCommands(opts: {
  input: HTMLTextAreaElement;
  /** 命令列表容器(在 .slip 内,靠 main.ts 的 fitWindow 自动长高,不用浮层/portal)。 */
  panel: HTMLElement;
  commands: CommandDef[];
  /** 执行一条命令:输入框已按命令类型改好,这里做副作用(切空间 / 设模式 / 加标签)。 */
  onExec: (id: string, arg: string) => void;
}): CaptureCommands {
  const { input, panel, commands, onExec } = opts;
  let matches: CommandDef[] = [];
  /** 候选行(排在命令行之后;`hi` 跨两段数)。只在恰好一条命令、词打全、有参数时非空。 */
  let options: string[] = [];
  let hi = 0;
  let dismissed = false; // Esc 关过面板,直到首行不再像命令才复位

  function firstLine(): string {
    const v = input.value;
    const nl = v.indexOf("\n");
    return nl === -1 ? v : v.slice(0, nl);
  }

  // 首行「像命令」= 以 / 起、命令词是纯英文字母、其后要么行尾要么空格接参数。
  // CJK 不入命令词(要求空格分隔参数),"/tag家庭" 这类无空格的当普通正文(返回 null)。
  function parseWord(): string | null {
    const m = firstLine().match(/^\/([a-z]*)(?:[ \t].*)?$/i);
    return m ? (m[1] ?? "").toLowerCase() : null;
  }

  function paintHi(): void {
    Array.from(panel.children).forEach((el, i) => el.classList.toggle("hi", i === hi));
  }

  function render(): void {
    panel.replaceChildren();
    if (matches.length === 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    matches.forEach((c, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cmd-row" + (i === hi ? " hi" : "");
      const name = document.createElement("span");
      name.className = "cmd-name";
      name.textContent = "/" + c.id;
      const label = document.createElement("span");
      label.className = "cmd-label";
      label.textContent = c.label;
      const hint = document.createElement("span");
      hint.className = "cmd-hint";
      hint.textContent = c.hint;
      row.append(name, label, hint);
      // mousedown(非 click):抢在 textarea 失焦前执行,焦点不跳。
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        exec(c);
      });
      row.addEventListener("mouseenter", () => {
        hi = i;
        paintHi();
      });
      panel.appendChild(row);
    });
    options.forEach((name, k) => {
      const i = matches.length + k;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cmd-row cmd-opt" + (i === hi ? " hi" : "");
      // 第一格留空占位(与命令行的「/tag」同宽),名字对齐在命令名那一列之后;写法同已挂上的标签 chip(#名字)。
      const pad = document.createElement("span");
      pad.className = "cmd-name";
      const label = document.createElement("span");
      label.className = "cmd-label";
      label.textContent = "#" + name;
      row.append(pad, label);
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        exec(matches[0], name);
      });
      row.addEventListener("mouseenter", () => {
        hi = i;
        paintHi();
      });
      panel.appendChild(row);
    });
  }

  /** 首行里命令词之后的参数(去首尾空白)。 */
  function argText(): string {
    return firstLine().replace(/^\/[a-z]*[ \t]*/i, "").trim();
  }

  function refresh(): void {
    const word = parseWord();
    if (word === null) {
      dismissed = false; // 首行不再像命令 → Esc 抑制解除
      matches = [];
      options = [];
      render();
      return;
    }
    if (dismissed) {
      matches = [];
      options = [];
      render();
      return;
    }
    matches = commands.filter((c) => (c.enabled ? c.enabled() : true) && c.id.startsWith(word));
    // 候选(902 E5):只在命令词打全(`/tag`,不是 `/ta`)且后面有字时问。高亮默认仍在命令那一行 ——
    // 不选直接回车 = 照旧拿打的字;↓ 才进候选。
    const only = matches.length === 1 && matches[0].id === word ? matches[0] : null;
    const arg = argText();
    const wasOn = hi >= matches.length ? options[hi - matches.length] : undefined;
    options = only?.argOptions && arg !== "" ? only.argOptions(arg).slice(0, MAX_OPTIONS) : [];
    // 高亮停在某枚候选上、接着又打了字:那一格换了人就回到命令行 —— 别让回车落在一枚没看过的候选上。
    if (hi >= matches.length + options.length || (wasOn !== undefined && options[hi - matches.length] !== wasOn)) hi = 0;
    render();
  }

  /** `picked` = 点名的候选(拿它当参数,不用打的那几个字)。 */
  function exec(cmd: CommandDef, picked?: string): void {
    const v = input.value;
    const nl = v.indexOf("\n");
    const line1 = nl === -1 ? v : v.slice(0, nl);
    const restLines = nl === -1 ? "" : v.slice(nl); // 含前导 \n
    // 剥掉真正打出的「/词」+ 其后空格(用实际输入而非 cmd.id 长度算——用户可能只打了前缀 /ta)。
    const argRaw = line1.replace(/^\/[a-z]*[ \t]*/i, "");
    if (cmd.takesArg) {
      input.value = restLines.replace(/^\n/, ""); // 参数消费掉,只留后续行
      onExec(cmd.id, picked ?? argRaw.trim());
    } else {
      input.value = argRaw + restLines; // 余下留作正文
      onExec(cmd.id, "");
    }
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    dismissed = false;
    refresh(); // 首行已不是命令 → 面板自行收起
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (panel.hidden || matches.length === 0) return false;
    const rows = matches.length + options.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        hi = (hi + 1) % rows;
        paintHi();
        return true;
      case "ArrowUp":
        e.preventDefault();
        hi = (hi - 1 + rows) % rows;
        paintHi();
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        if (hi < matches.length) exec(matches[hi]);
        else exec(matches[0], options[hi - matches.length]);
        return true;
      case "Escape":
        e.preventDefault();
        dismissed = true;
        matches = [];
        options = [];
        render();
        return true;
      default:
        return false;
    }
  }

  return {
    refresh,
    handleKey,
    isOpen: () => !panel.hidden,
  };
}
