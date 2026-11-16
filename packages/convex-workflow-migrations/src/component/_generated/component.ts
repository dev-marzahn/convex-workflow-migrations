/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    runs: {
      attempt: FunctionReference<
        "mutation",
        "internal",
        { attempts: number; workflowId: string },
        null,
        Name
      >;
      children: FunctionReference<
        "mutation",
        "internal",
        {
          children: Array<{ workflow: string; workflowId: string }>;
          parent: string;
        },
        null,
        Name
      >;
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        number,
        Name
      >;
      end: FunctionReference<
        "mutation",
        "internal",
        { paused?: boolean; workflowId: string },
        {
          detail: string;
          generationNumber: number;
          reason:
            | "mismatch"
            | "args"
            | "threw"
            | "migration"
            | "migrations"
            | "overlay";
        } | null,
        Name
      >;
      forget: FunctionReference<
        "mutation",
        "internal",
        {
          from?: { cursor: string | null; workflowId: string };
          journal?: string;
          workflowIds: Array<string>;
        },
        null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts?: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          workflow?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            at: number;
            attempts: number;
            detail: string;
            lastError?: string;
            nextAttemptAt: number;
            reason:
              | "mismatch"
              | "args"
              | "threw"
              | "migration"
              | "migrations"
              | "overlay";
            step?: number;
            workflow: string;
            workflowId: string;
          }>;
        },
        Name
      >;
      live: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          workflow: string;
        },
        { continueCursor: string; isDone: boolean; page: Array<string> },
        Name
      >;
      load: FunctionReference<
        "query",
        "internal",
        { workflowId: string },
        {
          applied?: Array<string>;
          format: number;
          live: boolean;
          origin: "start" | "child" | "adopted";
          overlay: Array<
            | {
                anchor: string;
                args?: any;
                id: string;
                kind: "function" | "workflow" | "event" | "sleep";
                name: string;
                op: "insert";
                result: any;
                where: "after" | "before";
              }
            | { op: "remove"; target: string }
            | { from: string; op: "truncate"; through: string }
            | {
                args?: any;
                name?: string;
                op: "rewrite";
                result?: any;
                target: string;
              }
            | { args: any; op: "workflowArgs" }
          >;
          parent?: string;
          paused?: {
            appliedCount: number;
            at: number;
            attempts: number;
            detail: string;
            generationNumber: number;
            handle: string;
            lastError?: string;
            nextAttemptAt: number;
            pausedRuns: number;
            reason:
              | "mismatch"
              | "args"
              | "threw"
              | "migration"
              | "migrations"
              | "overlay";
            restartFrom?: number;
            step?: number;
            stepId?: string;
          };
          restart?: string;
          workflow: string;
        } | null,
        Name
      >;
      origins: FunctionReference<
        "query",
        "internal",
        { workflowIds: Array<string> },
        Array<{ origin: "start" | "child" | "adopted"; workflowId: string }>,
        Name
      >;
      pause: FunctionReference<
        "mutation",
        "internal",
        {
          appliedCount: number;
          detail: string;
          generationNumber: number;
          handle: string;
          reason:
            | "mismatch"
            | "args"
            | "threw"
            | "migration"
            | "migrations"
            | "overlay";
          step?: number;
          stepId?: string;
          workflow: string;
          workflowId: string;
        },
        {
          attempts: number;
          notify: boolean;
          previousReason?:
            | "mismatch"
            | "args"
            | "threw"
            | "migration"
            | "migrations"
            | "overlay";
        },
        Name
      >;
      restart: FunctionReference<
        "mutation",
        "internal",
        { from?: string; workflow: string; workflowId: string },
        null,
        Name
      >;
      resumeAll: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null; until?: number; workflow?: string },
        null,
        Name
      >;
      retry: FunctionReference<
        "mutation",
        "internal",
        {
          due?: boolean;
          now?: boolean;
          restartFrom?: number;
          workflowId: string;
        },
        boolean,
        Name
      >;
      save: FunctionReference<
        "mutation",
        "internal",
        {
          applied: Array<string>;
          done: boolean;
          overlay: Array<
            | {
                anchor: string;
                args?: any;
                id: string;
                kind: "function" | "workflow" | "event" | "sleep";
                name: string;
                op: "insert";
                result: any;
                where: "after" | "before";
              }
            | { op: "remove"; target: string }
            | { from: string; op: "truncate"; through: string }
            | {
                args?: any;
                name?: string;
                op: "rewrite";
                result?: any;
                target: string;
              }
            | { args: any; op: "workflowArgs" }
          >;
          workflow: string;
          workflowId: string;
        },
        null,
        Name
      >;
      start: FunctionReference<
        "mutation",
        "internal",
        { applied: Array<string>; workflow: string; workflowId: string },
        null,
        Name
      >;
    };
  };
