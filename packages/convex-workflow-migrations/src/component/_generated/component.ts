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
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { keepPause?: boolean; workflowId: string },
        boolean,
        Name
      >;
      end: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        {
          detail: string;
          generationNumber: number;
          reason:
            | "mismatch"
            | "args"
            | "threw"
            | "migration"
            | "migrations"
            | "record";
        } | null,
        Name
      >;
      list: FunctionReference<
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
              | "record";
            step?: number;
            workflow: string;
            workflowId: string;
          }>;
        },
        Name
      >;
      load: FunctionReference<
        "query",
        "internal",
        { workflowId: string },
        {
          applied: Array<string>;
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
            | {
                args?: any;
                name?: string;
                op: "rewrite";
                result?: any;
                target: string;
              }
            | { args: any; op: "workflowArgs" }
          >;
          paused?: true;
        } | null,
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
            | "record";
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
            | "record";
        },
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        boolean,
        Name
      >;
      retry: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        null,
        Name
      >;
      save: FunctionReference<
        "mutation",
        "internal",
        {
          applied: Array<string>;
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
            | {
                args?: any;
                name?: string;
                op: "rewrite";
                result?: any;
                target: string;
              }
            | { args: any; op: "workflowArgs" }
          >;
          workflowId: string;
        },
        null,
        Name
      >;
    };
  };
