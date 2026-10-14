import { Directive } from "@angular/core";
import { classes } from "../utils/hlm";

@Directive({
  selector: "[hlmCardFooter],hlm-card-footer",
  host: { "data-slot": "card-footer" },
})
export class HlmCardFooter {
  constructor() {
    classes(() => "spartan-card-footer flex items-center");
  }
}
