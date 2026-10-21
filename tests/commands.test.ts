import { describe, expect, it } from 'vitest';
import {
  formatHelp,
  matchSlashCommands,
  parseSlashCommand,
} from '../src/core/commands';

describe('parseSlashCommand', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', arg: '', known: true });
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', arg: '', known: true });
  });

  it('parses a command with an argument', () => {
    expect(parseSlashCommand('/model gpt-4o')).toEqual({ name: 'model', arg: 'gpt-4o', known: true });
    expect(parseSlashCommand('/model   gpt-4o mini  ')).toEqual({
      name: 'model',
      arg: 'gpt-4o mini',
      known: true,
    });
  });

  it('marks unknown commands', () => {
    expect(parseSlashCommand('/frobnicate')).toEqual({ name: 'frobnicate', arg: '', known: false });
  });

  it('returns null for non-commands', () => {
    expect(parseSlashCommand('hello /new')).toBeNull();
    expect(parseSlashCommand('fill the form')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/123')).toBeNull();
  });
});

describe('matchSlashCommands (suggestion menu)', () => {
  it('matches by prefix', () => {
    expect(matchSlashCommands('/co').map((c) => c.name)).toEqual(['compact']);
    expect(matchSlashCommands('/re').map((c) => c.name)).toEqual(['reset', 'retry']);
    expect(matchSlashCommands('/').length).toBeGreaterThanOrEqual(10);
    expect(matchSlashCommands('/zzz')).toEqual([]);
  });
});

describe('formatHelp', () => {
  it('lists every command with its usage', () => {
    const help = formatHelp();
    expect(help).toContain('/compact');
    expect(help).toContain('/model <name>');
    expect(help).toContain('/new');
  });
});
