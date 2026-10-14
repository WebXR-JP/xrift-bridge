import { Directive } from "@angular/core";
import { classes } from "../utils/hlm";

@Directive({
  selector: "[hlmCardTitle]",
  host: { "data-slot": "card-title" },
})
export class HlmCardTitle {
  constructor() {
    classes(() => "spartan-card-title");
  }
}
