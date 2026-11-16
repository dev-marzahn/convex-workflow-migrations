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
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        number,
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
            nextAttemptAt: number;
            reason:
              | "mismatch"
              | "args"
              | "threw"
              | "migration"
              | "migrations"
              | "overlay"
              | "error";
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
          format?: number;
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
          paused?: {
            at: number;
            attempts: number;
            detail: string;
            generationNumber: number;
            handle: string;
            nextAttemptAt: number;
            reason:
              | "mismatch"
              | "args"
              | "threw"
              | "migration"
              | "migrations"
              | "overlay"
              | "error";
            step?: number;
          };
          restart?: number;
          workflow: string;
        } | null,
        Name
      >;
      pause: FunctionReference<
        "mutation",
        "internal",
        {
          detail: string;
          generationNumber: number;
          handle: string;
          reason:
            | "mismatch"
            | "args"
            | "threw"
            | "migration"
            | "migrations"
            | "overlay"
            | "error";
          step?: number;
          workflow: string;
          workflowId: string;
        },
        { first: boolean },
        Name
      >;
      resumeAll: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null; workflow?: string },
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
      unpause: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        null,
        Name
      >;
    };
  };
