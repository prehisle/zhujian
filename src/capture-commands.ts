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
};

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
  }

  function refresh(): void {
    const word = parseWord();
    if (word === null) {
      dismissed = false; // 首行不再像命令 → Esc 抑制解除
      matches = [];
      render();
      return;
    }
    if (dismissed) {
      matches = [];
      render();
      return;
    }
    matches = commands.filter((c) => (c.enabled ? c.enabled() : true) && c.id.startsWith(word));
    if (hi >= matches.length) hi = 0;
    render();
  }

  function exec(cmd: CommandDef): void {
    const v = input.value;
    const nl = v.indexOf("\n");
    const line1 = nl === -1 ? v : v.slice(0, nl);
    const restLines = nl === -1 ? "" : v.slice(nl); // 含前导 \n
    // 剥掉真正打出的「/词」+ 其后空格(用实际输入而非 cmd.id 长度算——用户可能只打了前缀 /ta)。
    const argRaw = line1.replace(/^\/[a-z]*[ \t]*/i, "");
    if (cmd.takesArg) {
      input.value = restLines.replace(/^\n/, ""); // 参数消费掉,只留后续行
      onExec(cmd.id, argRaw.trim());
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
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        hi = (hi + 1) % matches.length;
        paintHi();
        return true;
      case "ArrowUp":
        e.preventDefault();
        hi = (hi - 1 + matches.length) % matches.length;
        paintHi();
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        exec(matches[hi]);
        return true;
      case "Escape":
        e.preventDefault();
        dismissed = true;
        matches = [];
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
