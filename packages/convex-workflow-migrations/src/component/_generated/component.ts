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
      deployed: FunctionReference<
        "query",
        "internal",
        {},
        Array<{ declared: Array<string>; workflow: string }>,
        Name
      >;
      load: FunctionReference<
        "query",
        "internal",
        { workflow: string; workflowId: string },
        {
          deployed: Array<string> | null;
          markers: Array<{ beforeStepId: string; patchId: string }>;
          run: { known: Array<string>; workflow: string } | null;
          skips: Array<string>;
        },
        Name
      >;
      lookup: FunctionReference<
        "query",
        "internal",
        { workflowIds: Array<string> },
        Array<{
          run: { known: Array<string>; workflow: string } | null;
          skips: Array<string>;
          workflowId: string;
        }>,
        Name
      >;
      save: FunctionReference<
        "mutation",
        "internal",
        {
          deployed?: Array<string>;
          markers: Array<{ beforeStepId: string; patchId: string }>;
          run: { known: Array<string>; workflow: string };
          skips: Array<string>;
          unskip: Array<string>;
          workflowId: string;
        },
        null,
        Name
      >;
    };
  };
