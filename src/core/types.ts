/**
 * Domain types. Everything here is plain serializable data:
 * live DOM nodes never leave the content script, the rest of the
 * system only ever sees a PageSnapshot (JSON).
 */

export interface Fingerprint {
  tag: string;
  label: string;
  cssPath: string;
}

export interface ElementRef {
  index: number;
  tag: string;
  role?: string;
  /** Visible text / aria-label / name of the element, trimmed. */
  label: string;
  /** Current value for inputs/selects/textareas. */
  value?: string;
  /** The control's type attribute (text, email, checkbox, date, ...) for form fields. */
  inputType?: string;
  disabled?: boolean;
  /**
   * Surrounding context that identifies WHICH item this control belongs
   * to — e.g. the text of its table row ("USR-023 Nama23 Aktif"). Without
   * it, every row's Edit button looks identical to the model.
   */
  context?: string;
  placeholder?: string;
  href?: string;
  fingerprint: Fingerprint;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementRef[];
  /** Visible page text, already truncated by the collector. */
  text: string;
  capturedAt: number;
  /** Viewport size in CSS pixels (top frame). Element `bounds` are in
   *  this coordinate space; the screenshot is scaled from it. */
  viewport?: { width: number; height: number };
  /** True when the page carries substantial visual-only content
   *  (a large <img> or <canvas>) whose content the DOM text cannot
   *  describe — the trigger for screenshot observation. */
  visual?: boolean;
  /** Marked screenshot (data URL) of the visible tab, attached by the
   *  driver when vision observation applies. Numbered badges on it
   *  correspond to `elements` indices. Never leaves the run: hashing
   *  and step logs ignore it. */
  screenshot?: string;
}

/** One earlier exchange in the chat, fed back to the model so follow-up
 *  questions ("how many did you add?") are answered from what the agent
 *  actually did — not guessed from the current page. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type Action =
  | { type: 'click'; index: number }
  /** Click at an offset (px) inside the element — for canvas UIs and
   *  widgets where the meaningful target is a region, not an element. */
  | { type: 'click_at'; index: number; x: number; y: number }
  | { type: 'type'; index: number; text: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'navigate'; url: string }
  | { type: 'wait'; ms: number }
  | { type: 'done'; summary: string }
  | { type: 'ask_user'; question: string };

export interface ActResult {
  ok: boolean;
  message: string;
  /** Which actuator level succeeded/was used (0 = plain DOM, higher = stronger fallback). */
  level: number;
}

export interface StepRecord {
  step: number;
  snapshotHash: string;
  action: Action;
  result?: ActResult;
}

export type AgentStatus =
  | 'done'
  | 'max_steps'
  | 'stuck'
  | 'needs_user'
  | 'error'
  | 'aborted';

export interface AgentRunResult {
  status: AgentStatus;
  summary: string;
  history: StepRecord[];
}

/** Chat layer (ChatGPT/Gemini-style): a session is one conversation. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** Final agent status for assistant messages that report a run. */
  status?: AgentStatus;
  /** Step log lines of the run, rendered collapsed inside the bubble. */
  steps?: string[];
  /** Structured step records for the timeline view (action + result). */
  stepRecords?: StepRecord[];
  /** Local UI notice (slash-command feedback): rendered in the chat but
   *  NEVER handed to the model as conversation history. */
  local?: boolean;
  /** Debug view of what this user turn injected into the agent prompt
   *  (conversation memory). Collapsed by default in the UI. */
  injectedContext?: string;
}

export interface ChatSession {
  id: string;
  /** Window that created this session (informational; any window may open it). */
  windowId: number;
  /** Tab that created this session (informational; sessions are bound
   *  to tabs via ChatState.byTab, and any tab may open any session). */
  tabId?: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Set by /compact: an LLM-written summary of everything up to
   *  `compactCutoff`. buildConversation hands the model this summary
   *  instead of the folded messages. */
  compactSummary?: string;
  /** `ts` of the last message folded into `compactSummary`. */
  compactCutoff?: number;
}

/**
 * Whole chat state. `byTab` is the per-TAB session binding: each tab
 * resumes its OWN active session, a new tab starts a fresh one — while
 * every session stays in the shared history. (Was per-window until the
 * per-tab panel change; the store migrates old states by dropping the
 * old bindings and keeping the sessions.)
 */
export interface ChatState {
  sessions: ChatSession[];
  byTab: Record<number, string>;
}
