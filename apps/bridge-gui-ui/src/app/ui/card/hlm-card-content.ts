import { Directive } from "@angular/core";
import { classes } from "../utils/hlm";

@Directive({
  selector: "[hlmCardContent]",
  host: { "data-slot": "card-content" },
})
export class HlmCardContent {
  constructor() {
    classes(() => "spartan-card-content");
  }
}
