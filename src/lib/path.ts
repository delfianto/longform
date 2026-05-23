import { last } from "lodash";

export function fileNameFromPath(path: string): string {
  return last(path.split("/")).split(".md")[0];
}
