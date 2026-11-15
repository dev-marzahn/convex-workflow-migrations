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
    markers: {
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
        { workflowId: string },
        Array<{ beforeStepId: string; patchId: string }>,
        Name
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          markers: Array<{ beforeStepId: string; patchId: string }>;
          workflowId: string;
        },
        null,
        Name
      >;
      runsWithPatch: FunctionReference<
        "query",
        "internal",
        { patchId: string },
        Array<string>,
        Name
      >;
      withPatch: FunctionReference<
        "query",
        "internal",
        { patchId: string; workflowIds: Array<string> },
        Array<string>,
        Name
      >;
    };
  };
