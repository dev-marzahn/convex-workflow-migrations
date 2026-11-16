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
        { limit?: number },
        Array<{
          at: number;
          attempts: number;
          detail: string;
          nextAttemptAt: number;
          reason: "mismatch" | "migration" | "migrations" | "error";
          step?: number;
          workflow: string;
          workflowId: string;
        }>,
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
            | {
                anchor: string;
                args: any;
                executedAs?: string;
                id: string;
                kind: "function" | "workflow" | "event" | "sleep";
                name: string;
                op: "insertLate";
                where: "after" | "before";
              }
            | { op: "remove"; target: string }
            | { args?: any; name?: string; op: "rewrite"; target: string }
          >;
          paused?: {
            at: number;
            attempts: number;
            detail: string;
            generationNumber: number;
            handle: string;
            nextAttemptAt: number;
            reason: "mismatch" | "migration" | "migrations" | "error";
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
          reason: "mismatch" | "migration" | "migrations" | "error";
          record?: {
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
              | {
                  anchor: string;
                  args: any;
                  executedAs?: string;
                  id: string;
                  kind: "function" | "workflow" | "event" | "sleep";
                  name: string;
                  op: "insertLate";
                  where: "after" | "before";
                }
              | { op: "remove"; target: string }
              | { args?: any; name?: string; op: "rewrite"; target: string }
            >;
          };
          step?: number;
          workflow: string;
          workflowId: string;
        },
        { first: boolean },
        Name
      >;
      retry: FunctionReference<
        "mutation",
        "internal",
        { now?: boolean; restartFrom?: number; workflowId: string },
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
            | {
                anchor: string;
                args: any;
                executedAs?: string;
                id: string;
                kind: "function" | "workflow" | "event" | "sleep";
                name: string;
                op: "insertLate";
                where: "after" | "before";
              }
            | { op: "remove"; target: string }
            | { args?: any; name?: string; op: "rewrite"; target: string }
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
