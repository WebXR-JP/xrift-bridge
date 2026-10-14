import { Directive } from "@angular/core";
import { BrnAccordionItem } from "@spartan-ng/brain/accordion";
import { classes } from "../utils/hlm";

@Directive({
  selector: "[hlmAccordionItem],hlm-accordion-item",
  hostDirectives: [
    {
      directive: BrnAccordionItem,
      inputs: ["isOpened", "disabled"],
      outputs: ["openedChange"],
    },
  ],
  host: {
    "data-slot": "accordion-item",
  },
})
export class HlmAccordionItem {
  constructor() {
    classes(() => "spartan-accordion-item flex flex-col");
  }
}
