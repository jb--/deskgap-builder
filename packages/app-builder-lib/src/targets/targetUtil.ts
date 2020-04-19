import { Arch, debug } from "builder-util";
import { emptyDir, remove } from "fs-extra";
import * as path from "path";
import { AppInfo, Target } from "..";
import { PlatformPackager } from "../platformPackager";

export class StageDir {
  constructor(readonly dir: string) {}

  cleanup() {
    if (!debug.enabled || process.env.ELECTRON_BUILDER_REMOVE_STAGE_EVEN_IF_DEBUG === "true") return remove(this.dir);

    return Promise.resolve();
  }

  getTempFile(name: string) {
    return this.dir + path.sep + name;
  }

  toString() {
    return this.dir;
  }
}

export async function createStageDir(target: Target, packager: PlatformPackager<any>, arch: Arch): Promise<StageDir> {
  return new StageDir(await createStageDirPath(target, packager, arch));
}

export async function createStageDirPath(target: Target, packager: PlatformPackager<any>, arch: Arch): Promise<string> {
  const tempDir = packager.info.stageDirPathCustomizer(target, packager, arch);
  await emptyDir(tempDir);
  return tempDir;
}

// https://github.com/deskgap-userland/deskgap-builder/issues/3100
// https://github.com/deskgap-userland/deskgap-builder/commit/2539cfba20dc639128e75c5b786651b652bb4b78
export function getWindowsInstallationDirName(appInfo: AppInfo, isTryToUseProductName: boolean): string {
  return isTryToUseProductName && /^[-_+0-9a-zA-Z .]+$/.test(appInfo.productFilename)
    ? appInfo.productFilename
    : appInfo.sanitizedName;
}
