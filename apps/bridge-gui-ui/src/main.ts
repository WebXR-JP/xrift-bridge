/**
 * Angular 画面の起動点。
 *
 * 変更検知は zoneless＋signals とし、`zone.js` を読み込まない。push 到達後の
 * 再描画は signal の更新で予定される。起動失敗は記録だけ残す。
 */
import { provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component.ts";

bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection()],
}).catch((error) => {
  console.log(`[bridge-gui-ng] 起動に失敗した: ${String(error)}`);
});
