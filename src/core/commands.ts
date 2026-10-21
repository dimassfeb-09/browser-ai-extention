/**
 * Slash commands for the chat composer — handled LOCALLY by the panel
 * (agent-style), never sent to the model as a goal. Parsing and the
 * command registry live here so the UI, /help output and the
 * suggestion menu all share one source of truth.
 */

export interface SlashCommandDef {
  /** Name without the slash, e.g. 'compact'. */
  name: string;
  /** Display form, e.g. '/model <name>'. */
  usage: string;
  description: string;
  takesArg?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'help', usage: '/help', description: 'List all slash commands' },
  { name: 'new', usage: '/new', description: 'Start a new chat' },
  { name: 'reset', usage: '/reset', description: 'Clear this chat (messages + agent memory), keep the session' },
  { name: 'clear', usage: '/clear', description: 'Alias of /reset' },
  { name: 'compact', usage: '/compact', description: 'Summarize earlier turns into one brief — future runs carry less context' },
  { name: 'stop', usage: '/stop', description: 'Stop the running task' },
  { name: 'retry', usage: '/retry', description: 'Run the last goal again' },
  { name: 'model', usage: '/model <name>', description: 'Show the current model, or switch to <name>', takesArg: true },
  { name: 'settings', usage: '/settings', description: 'Open AI Configuration' },
  { name: 'export', usage: '/export', description: 'Download this chat as a Markdown file' },
];

export interface ParsedSlashCommand {
  name: string;
  arg: string;
  known: boolean;
}

/** Parse '/model gpt-4o' → { name: 'model', arg: 'gpt-4o' }. Returns
 *  null when the text is not command-shaped (no leading slash + name). */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = (m[1] ?? '').toLowerCase();
  return {
    name,
    arg: (m[2] ?? '').trim(),
    known: SLASH_COMMANDS.some((c) => c.name === name),
  };
}

/** Commands whose name starts with the typed prefix (for the
 *  suggestion menu shown while typing '/…'). */
export function matchSlashCommands(typed: string): SlashCommandDef[] {
  const p = typed.replace(/^\//, '').toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p));
}

export function formatHelp(): string {
  return [
    'Slash commands (handled locally, not sent to the model):',
    ...SLASH_COMMANDS.map((c) => `${c.usage} — ${c.description}`),
  ].join('\n');
}
