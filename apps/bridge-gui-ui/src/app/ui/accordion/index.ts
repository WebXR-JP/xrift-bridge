import { HlmAccordion } from "./hlm-accordion.ts";
import { HlmAccordionContent } from "./hlm-accordion-content.ts";
import { HlmAccordionContentLazy } from "./hlm-accordion-content-lazy.ts";
import { HlmAccordionItem } from "./hlm-accordion-item.ts";
import { HlmAccordionTrigger } from "./hlm-accordion-trigger.ts";

export * from "./hlm-accordion.ts";
export * from "./hlm-accordion-content.ts";
export * from "./hlm-accordion-content-lazy.ts";
export * from "./hlm-accordion-item.ts";
export * from "./hlm-accordion-trigger.ts";

export const HlmAccordionImports = [
  HlmAccordion,
  HlmAccordionItem,
  HlmAccordionContent,
  HlmAccordionContentLazy,
  HlmAccordionTrigger,
] as const;
