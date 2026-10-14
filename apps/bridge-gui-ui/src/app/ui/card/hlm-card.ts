import { Directive, input } from "@angular/core";
import { classes } from "../utils/hlm.ts";
import type { HlmCardConfig } from "./hlm-card.token.ts";
import { injectHlmCardConfig } from "./hlm-card.token.ts";

@Directive({
  selector: "[hlmCard],hlm-card",
  host: {
    "data-slot": "card",
    "[attr.data-size]": "size()",
  },
})
export class HlmCard {
  private readonly _defaultConfig = injectHlmCardConfig();
  public readonly size = input<HlmCardConfig["size"]>(this._defaultConfig.size);

  constructor() {
    classes(() => "spartan-card group/card flex flex-col");
  }
}
