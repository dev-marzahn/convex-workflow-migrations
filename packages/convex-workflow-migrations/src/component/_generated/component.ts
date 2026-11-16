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
        boolean,
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
        } | null,
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
