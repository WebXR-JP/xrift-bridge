import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // GUI 自体の単体検証は tests/ のみである（bridge-gui と同様）。
    include: ["tests/**/*.test.ts"],
  },
});
