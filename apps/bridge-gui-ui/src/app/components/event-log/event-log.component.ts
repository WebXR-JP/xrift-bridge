/**
 * 受信記録（イベントログ）の表示部品。
 *
 * 採用／無視の符号と操作結果の要約だけを示す。本文・payload は載せない。
 * 時刻はサービスが記録時に付けた値をそのまま示し、ここでは生成しない。
 */
import { Component, input } from "@angular/core";
import type { EventLogEntry } from "../../Services/management.service.ts";

@Component({
  selector: "app-event-log",
  standalone: true,
  templateUrl: "./event-log.component.html",
})
export class EventLogComponent {
  /** 受信記録の一覧。新しいほど末尾である。 */
  readonly entries = input<readonly EventLogEntry[]>([]);
}
