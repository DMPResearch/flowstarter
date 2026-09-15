import { createElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";
import { EDITOR_BASE_PATH } from "./lib/basePath";

// Mirror Vite's `base` so TanStack Router keeps the prefix in URLs and
// link generation (see `lib/basePath.ts`). When deployed at root,
// EDITOR_BASE_PATH is '' and basepath becomes '' (TanStack default).
const baseUrl = EDITOR_BASE_PATH;

export function getRouter(history: RouterHistory, queryClient: QueryClient) {
  return createRouter({
    routeTree,
    history,
    ...(baseUrl ? { basepath: baseUrl } : {}),
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(AppAtomRegistryProvider, undefined, children),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
