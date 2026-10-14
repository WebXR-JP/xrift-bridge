import { HlmTabs } from "./hlm-tabs.ts";
import { HlmTabsContent } from "./hlm-tabs-content.ts";
import { HlmTabsContentLazy } from "./hlm-tabs-content-lazy.ts";
import { HlmTabsList } from "./hlm-tabs-list.ts";
import { HlmTabsTrigger } from "./hlm-tabs-trigger.ts";

export * from "./hlm-tabs.ts";
export * from "./hlm-tabs-content.ts";
export * from "./hlm-tabs-content-lazy.ts";
export * from "./hlm-tabs-list.ts";
export * from "./hlm-tabs-trigger.ts";

export const HlmTabsImports = [
  HlmTabs,
  HlmTabsList,
  HlmTabsTrigger,
  HlmTabsContent,
  HlmTabsContentLazy,
] as const;
