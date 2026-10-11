/**
 * Angular スパイクの起動点。
 *
 * 変更検知は既定の zone 方式とし、起動失敗は記録だけ残す。
 * RPC・表示状態の契約はサービス側で再利用する。
 */
import "zone.js";
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component.ts";

bootstrapApplication(AppComponent).catch((error) => {
  console.log(`[bridge-gui-ng] 起動に失敗した: ${String(error)}`);
});
