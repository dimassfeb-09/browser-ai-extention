import { z } from 'zod';
import type { Action } from './types';

/**
 * LLM output is untrusted input: every action the model proposes is
 * validated against this schema before anything executes it.
 */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), index: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('click_at'),
    index: z.number().int().nonnegative(),
    x: z.number().min(0).max(10_000),
    y: z.number().min(0).max(10_000),
  }),
  z.object({
    type: z.literal('type'),
    index: z.number().int().nonnegative(),
    text: z.string().max(10_000),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().positive().max(100_000).optional(),
  }),
  z.object({ type: z.literal('navigate'), url: z.string().url().max(2_048) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal('done'), summary: z.string().max(2_000) }),
  z.object({ type: z.literal('ask_user'), question: z.string().max(2_000) }),
]);

export function parseAction(raw: unknown): Action {
  return actionSchema.parse(raw) as Action;
}

/** Flat tool-args shape returned by the model, mapped into an Action.
 *  Optional fields are nullish: real models routinely send null for
 *  unused fields instead of omitting them — that is not an error. */
const toolArgsSchema = z.object({
  type: z.enum(['click', 'click_at', 'type', 'scroll', 'navigate', 'wait', 'done', 'ask_user']),
  index: z.number().int().nonnegative().nullish(),
  x: z.number().min(0).nullish(),
  y: z.number().min(0).nullish(),
  text: z.string().nullish(),
  direction: z.enum(['up', 'down']).nullish(),
  amount: z.number().int().positive().nullish(),
  url: z.string().nullish(),
  ms: z.number().int().min(0).nullish(),
  summary: z.string().nullish(),
  question: z.string().nullish(),
});

export function actionFromToolArgs(rawArgs: unknown): Action {
  const raw = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  const args = toolArgsSchema.parse(raw);
  switch (args.type) {
    case 'click':
      return parseAction({ type: 'click', index: args.index ?? -1 });
    case 'click_at':
      return parseAction({
        type: 'click_at',
        index: args.index ?? -1,
        x: args.x ?? 0,
        y: args.y ?? 0,
      });
    case 'type':
      return parseAction({ type: 'type', index: args.index ?? -1, text: args.text ?? '' });
    case 'scroll':
      return parseAction({
        type: 'scroll',
        direction: args.direction ?? 'down',
        amount: args.amount,
      });
    case 'navigate':
      return parseAction({ type: 'navigate', url: args.url ?? '' });
    case 'wait':
      return parseAction({ type: 'wait', ms: args.ms ?? 1_000 });
    case 'done':
      return parseAction({ type: 'done', summary: args.summary ?? 'Done.' });
    case 'ask_user':
      return parseAction({ type: 'ask_user', question: args.question ?? 'Need your help.' });
  }
}

/** OpenAI chat-completions tool definition for the single browser_action tool. */
export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'browser_action',
      description:
        'Perform exactly one action on the current web page, then you will receive a fresh snapshot. Indices refer to the numbered elements of the latest snapshot.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['click', 'click_at', 'type', 'scroll', 'navigate', 'wait', 'done', 'ask_user'],
            description: 'The action to perform.',
          },
          index: { type: 'number', description: 'Element index from the snapshot (click/type).' },
          x: { type: 'number', description: 'X offset in px inside the element (click_at, e.g. canvas regions).' },
          y: { type: 'number', description: 'Y offset in px inside the element (click_at).' },
          text: { type: 'string', description: 'Text to type (type).' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
          amount: { type: 'number', description: 'Scroll pixels (optional).' },
          url: { type: 'string', description: 'URL to navigate to (navigate).' },
          ms: { type: 'number', description: 'Milliseconds to wait, max 30000 (wait).' },
          summary: { type: 'string', description: 'What was accomplished (done).' },
          question: { type: 'string', description: 'What you need from the user (ask_user).' },
        },
        required: ['type'],
      },
    },
  },
];
