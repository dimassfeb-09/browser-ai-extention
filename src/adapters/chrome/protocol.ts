import type { Action, ActResult, PageSnapshot } from '../../core/types';

/** Message protocol between the side panel and the content script. */
export type ContentRequest =
  | { kind: 'waa:observe' }
  | { kind: 'waa:act'; action: Action };

export type ContentResponse =
  | { kind: 'waa:snapshot'; snapshot: PageSnapshot }
  | { kind: 'waa:act-result'; result: ActResult }
  | { kind: 'waa:error'; message: string };
