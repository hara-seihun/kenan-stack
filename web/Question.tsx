import { createContext, lazy } from 'react';
import type { Todo } from '../shared/contract.js';

/** Her open and answered questions (to-dos with options) and how a tap answers one; null where the to-do list isn't loaded. */
export interface Questions { todos: Todo[] | null; answer(id: string, choice: string): Promise<void>; dismiss(id: string): Promise<void> }
export const QuestionContext = createContext<Questions | null>(null);

/** The answer buttons load with the first question shown (kept out of the startup bundle). */
export const QuestionButtons = lazy(() => import('./QuestionButtons.js'));
