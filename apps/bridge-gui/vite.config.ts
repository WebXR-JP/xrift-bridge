import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Hutch の生成物（.hutch/devkit 配下の __tests__）を拾わない。
    // GUI 自体の単体検証は tests/ のみである。
    include: ["tests/**/*.test.ts"],
  },
});
