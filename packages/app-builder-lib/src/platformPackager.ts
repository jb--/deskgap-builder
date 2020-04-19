import * as BluebirdPromise from "bluebird-lst";
import {
  Arch,
  asArray,
  AsyncTaskManager,
  debug,
  DebugLogger,
  deepAssign,
  getArchSuffix,
  InvalidConfigurationError,
  isEmptyOrSpaces,
  isEnvTrue,
  log,
} from "builder-util";
import { getArtifactArchName } from "builder-util/out/arch";
import { FileTransformer, statOrNull } from "builder-util/out/fs";
import { orIfFileNotExist } from "builder-util/out/promise";
import { readdir } from "fs-extra";
import { Lazy } from "lazy-val";
import { Minimatch } from "minimatch";
import * as path from "path";
import { AppInfo } from "./appInfo";
import { checkFileInArchive } from "./asar/asarFileChecker";
import { AsarPackager } from "./asar/asarUtil";
import { computeData } from "./asar/integrity";
import {
  copyFiles,
  FileMatcher,
  getFileMatchers,
  GetFileMatchersOptions,
  getMainFileMatchers,
  getNodeModuleFileMatcher,
} from "./fileMatcher";
import { createTransformer, isDeskGapCompileUsed } from "./fileTransformer";
import { Framework, isDeskGapBased } from "./Framework";
import {
  AfterPackContext,
  AsarOptions,
  CompressionLevel,
  Configuration,
  DeskGapPlatformName,
  FileAssociation,
  Packager,
  PackagerOptions,
  Platform,
  PlatformSpecificBuildOptions,
  Target,
  TargetSpecificOptions,
} from "./index";
import { executeAppBuilderAsJson } from "./util/appBuilder";
import {
  computeFileSets,
  computeNodeModuleFileSets,
  copyAppFiles,
  ELECTRON_COMPILE_SHIM_FILENAME,
  transformFiles,
} from "./util/appFileCopier";
import { expandMacro as doExpandMacro } from "./util/macroExpander";

export abstract class PlatformPackager<DC extends PlatformSpecificBuildOptions> {
  get buildResourcesDir(): string {
    return this.info.buildResourcesDir;
  }

  get compression(): CompressionLevel {
    const { compression } = this.platformSpecificBuildOptions;
    // explicitly set to null - request to use default value instead of parent (in the config)
    if (compression === null) return "normal";

    return compression || this.config.compression || "normal";
  }

  get config(): Configuration {
    return this.info.config;
  }

  get debugLogger(): DebugLogger {
    return this.info.debugLogger;
  }

  abstract get defaultTarget(): string[];

  get fileAssociations(): FileAssociation[] {
    return asArray(this.config.fileAssociations).concat(asArray(this.platformSpecificBuildOptions.fileAssociations));
  }

  get forceCodeSigning(): boolean {
    const forceCodeSigningPlatform = this.platformSpecificBuildOptions.forceCodeSigning;
    return (forceCodeSigningPlatform == null ? this.config.forceCodeSigning : forceCodeSigningPlatform) || false;
  }

  get packagerOptions(): PackagerOptions {
    return this.info.options;
  }

  get projectDir(): string {
    return this.info.projectDir;
  }

  get resourceList(): Promise<string[]> {
    return this._resourceList.value;
  }

  protected constructor(readonly info: Packager, readonly platform: Platform) {
    this.platformSpecificBuildOptions = PlatformPackager.normalizePlatformSpecificBuildOptions(
      (this.config as any)[platform.buildConfigurationKey],
    );
    this.appInfo = this.prepareAppInfo(info.appInfo);
  }

  private static buildAsyncTargets(targets: Target[], taskManager: AsyncTaskManager, appOutDir: string, arch: Arch) {
    for (const target of targets) if (target.isAsyncSupported) taskManager.addTask(target.build(appOutDir, arch));
  }

  private static normalizePlatformSpecificBuildOptions(options: any | null | undefined): any {
    return options == null ? Object.create(null) : options;
  }

  readonly appInfo: AppInfo;

  readonly platformSpecificBuildOptions: DC;

  private readonly _resourceList = new Lazy<string[]>(() => orIfFileNotExist(readdir(this.info.buildResourcesDir), []));

  // tslint:disable-next-line:no-invalid-template-strings
  computeSafeArtifactName(
    suggestedName: string | null,
    ext: string,
    arch?: Arch | null,
    skipArchIfX64 = true,
    safePattern: string = "${name}-${version}-${arch}.${ext}",
  ): string | null {
    return computeSafeArtifactNameIfNeeded(suggestedName, () =>
      this.computeArtifactName(safePattern, ext, skipArchIfX64 && arch === Arch.x64 ? null : arch),
    );
  }

  createGetFileMatchersOptions(
    outDir: string,
    arch: Arch,
    customBuildOptions: PlatformSpecificBuildOptions,
  ): GetFileMatchersOptions {
    return {
      macroExpander: (it) => this.expandMacro(it, arch == null ? null : Arch[arch], { "/*": "{,/**/*}" }),
      customBuildOptions,
      globalOutDir: outDir,
      defaultSrc: this.projectDir,
    };
  }

  abstract createTargets(targets: string[], mapper: (name: string, factory: (outDir: string) => Target) => void): void;

  dispatchArtifactCreated(
    file: string,
    target: Target | null,
    arch: Arch | null,
    safeArtifactName?: string | null,
  ): Promise<void> {
    return this.info.callArtifactBuildCompleted({
      file,
      safeArtifactName,
      target,
      arch,
      packager: this,
    });
  }

  expandArtifactBeautyNamePattern(
    targetSpecificOptions: TargetSpecificOptions | null | undefined,
    ext: string,
    arch?: Arch | null,
  ): string {
    // tslint:disable-next-line:no-invalid-template-strings
    return this.expandArtifactNamePattern(
      targetSpecificOptions,
      ext,
      arch,
      "${productName} ${version} ${arch}.${ext}",
      true,
    );
  }

  expandArtifactNamePattern(
    targetSpecificOptions: TargetSpecificOptions | null | undefined,
    ext: string,
    arch?: Arch | null,
    defaultPattern?: string,
    skipArchIfX64 = true,
  ): string {
    let pattern = targetSpecificOptions == null ? null : targetSpecificOptions.artifactName;
    if (pattern == null) pattern = this.platformSpecificBuildOptions.artifactName || this.config.artifactName;

    if (pattern == null)
      // tslint:disable-next-line:no-invalid-template-strings
      pattern = defaultPattern || "${productName}-${version}-${arch}.${ext}";
    // https://github.com/deskgap-userland/deskgap-builder/issues/3510
    // always respect arch in user custom artifact pattern
    else skipArchIfX64 = false;

    return this.computeArtifactName(pattern, ext, skipArchIfX64 && arch === Arch.x64 ? null : arch);
  }

  expandMacro(pattern: string, arch?: string | null, extra: any = {}, isProductNameSanitized = true): string {
    return doExpandMacro(
      pattern,
      arch,
      this.appInfo,
      { os: this.platform.buildConfigurationKey, ...extra },
      isProductNameSanitized,
    );
  }

  generateName2(ext: string | null, classifier: string | null | undefined, deployment: boolean): string {
    const dotExt = ext == null ? "" : `.${ext}`;
    const separator = ext === "deb" ? "_" : "-";
    return `${deployment ? this.appInfo.name : this.appInfo.productFilename}${separator}${this.appInfo.version}${
      classifier == null ? "" : `${separator}${classifier}`
    }${dotExt}`;
  }

  getDefaultFrameworkIcon(): string | null {
    const { framework } = this.info;
    return framework.getDefaultIcon == null ? null : framework.getDefaultIcon(this.platform);
  }

  public getDeskGapDestinationDir(appOutDir: string): string {
    return appOutDir;
  }

  public getDeskGapSrcDir(dist: string): string {
    return path.resolve(this.projectDir, dist);
  }

  async getIconPath(): Promise<string | null> {
    return null;
  }

  public getMacOsResourcesDir(appOutDir: string): string {
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Resources");
  }

  async getResource(custom: string | null | undefined, ...names: string[]): Promise<string | null> {
    const resourcesDir = this.info.buildResourcesDir;
    if (custom === undefined) {
      const resourceList = await this.resourceList;
      for (const name of names) if (resourceList.includes(name)) return path.join(resourcesDir, name);
    } else if (custom != null && !isEmptyOrSpaces(custom)) {
      const resourceList = await this.resourceList;
      if (resourceList.includes(custom)) return path.join(resourcesDir, custom);

      let p = path.resolve(resourcesDir, custom);
      if ((await statOrNull(p)) == null) {
        p = path.resolve(this.projectDir, custom);
        if ((await statOrNull(p)) == null)
          throw new InvalidConfigurationError(
            `cannot find specified resource "${custom}", nor relative to "${resourcesDir}", neither relative to project dir ("${this.projectDir}")`,
          );
      }
      return p;
    }
    return null;
  }

  getResourcesDir(appOutDir: string): string {
    if (this.platform === Platform.MAC) return this.getMacOsResourcesDir(appOutDir);
    if (isDeskGapBased(this.info.framework)) return path.join(appOutDir, "resources");

    return appOutDir;
  }

  getTempFile(suffix: string): Promise<string> {
    return this.info.tempDirManager.getTempFile({ suffix });
  }

  async pack(outDir: string, arch: Arch, targets: Target[], taskManager: AsyncTaskManager): Promise<any> {
    const appOutDir = this.computeAppOutDir(outDir, arch);
    await this.doPack(
      outDir,
      appOutDir,
      this.platform.nodeName as DeskGapPlatformName,
      arch,
      this.platformSpecificBuildOptions,
      targets,
    );
    this.packageInDistributableFormat(appOutDir, arch, targets, taskManager);
  }

  // convert if need, validate size (it is a reason why tool is called even if file has target extension (already specified as foo.icns for example))
  async resolveIcon(sources: string[], fallbackSources: string[], outputFormat: IconFormat): Promise<IconInfo[]> {
    const args = [
      "icon",
      "--format",
      outputFormat,
      "--root",
      this.buildResourcesDir,
      "--root",
      this.projectDir,
      "--out",
      path.resolve(this.projectDir, this.config.directories!.output!, `.icon-${outputFormat}`),
    ];
    for (const source of sources) args.push("--input", source);

    for (const source of fallbackSources) args.push("--fallback-input", source);

    const result: IconConvertResult = await executeAppBuilderAsJson(args);
    const errorMessage = result.error;
    if (errorMessage != null) throw new InvalidConfigurationError(errorMessage, result.errorCode);

    if (result.isFallback)
      log.warn(
        { reason: "application icon is not set" },
        `default ${capitalizeFirstLetter(this.info.framework.name)} icon is used`,
      );

    return result.icons || [];
  }

  protected computeAppOutDir(outDir: string, arch: Arch): string {
    return (
      this.packagerOptions.prepackaged ||
      path.join(
        outDir,
        `${this.platform.buildConfigurationKey}${getArchSuffix(arch)}${
          this.platform === Platform.MAC ? "" : "-unpacked"
        }`,
      )
    );
  }

  // eslint-disable-next-line
  protected createTransformerForExtraFiles(packContext: AfterPackContext): FileTransformer | null {
    return null;
  }

  protected doGetCscPassword(): string | null | undefined {
    // allow to specify as empty string
    return chooseNotNull(
      chooseNotNull(this.info.config.cscKeyPassword, this.platformSpecificBuildOptions.cscKeyPassword),
      process.env.CSC_KEY_PASSWORD,
    );
  }

  protected async doPack(
    outDir: string,
    appOutDir: string,
    platformName: DeskGapPlatformName,
    arch: Arch,
    platformSpecificBuildOptions: DC,
    targets: Target[],
  ) {
    if (this.packagerOptions.prepackaged != null) return;

    const { framework } = this.info;
    log.info(
      {
        platform: platformName,
        arch: Arch[arch],
        [`${framework.name}`]: framework.version,
        appOutDir: log.filePath(appOutDir),
      },
      `packaging`,
    );

    await framework.prepareApplicationStageDirectory({
      packager: this,
      appOutDir,
      platformName,
      arch: Arch[arch],
      version: framework.version,
    });

    const excludePatterns: Minimatch[] = [];

    const computeParsedPatterns = (patterns: FileMatcher[] | null) => {
      if (patterns != null)
        for (const pattern of patterns) pattern.computeParsedPatterns(excludePatterns, this.info.projectDir);
    };

    const getFileMatchersOptions = this.createGetFileMatchersOptions(outDir, arch, platformSpecificBuildOptions);
    const { macroExpander } = getFileMatchersOptions;
    const extraResourceMatchers = this.getExtraFileMatchers(true, appOutDir, getFileMatchersOptions);
    computeParsedPatterns(extraResourceMatchers);
    const extraFileMatchers = this.getExtraFileMatchers(false, appOutDir, getFileMatchersOptions);
    computeParsedPatterns(extraFileMatchers);

    const packContext: AfterPackContext = {
      appOutDir,
      outDir,
      arch,
      targets,
      packager: this,
      deskgapPlatformName: platformName,
    };

    const asarOptions = await this.computeAsarOptions(platformSpecificBuildOptions);
    const resourcesPath =
      this.platform === Platform.MAC
        ? path.join(appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : isDeskGapBased(framework)
        ? path.join(appOutDir, "resources")
        : appOutDir;
    const taskManager = new AsyncTaskManager(this.info.cancellationToken);
    this.copyAppFiles(
      taskManager,
      asarOptions,
      resourcesPath,
      path.join(resourcesPath, "app"),
      packContext,
      platformSpecificBuildOptions,
      excludePatterns,
      macroExpander,
    );
    await taskManager.awaitTasks();

    if (this.info.cancellationToken.cancelled) return;

    if (framework.beforeCopyExtraFiles != null)
      await framework.beforeCopyExtraFiles({
        packager: this,
        appOutDir,
        asarIntegrity:
          asarOptions == null
            ? null
            : await computeData(resourcesPath, asarOptions.externalAllowed ? { externalAllowed: true } : null),
        platformName,
      });

    if (this.info.cancellationToken.cancelled) return;

    const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext);
    await copyFiles(extraResourceMatchers, transformerForExtraFiles);
    await copyFiles(extraFileMatchers, transformerForExtraFiles);

    if (this.info.cancellationToken.cancelled) return;

    await this.info.afterPack(packContext);

    if (framework.afterPack != null) await framework.afterPack(packContext);

    const isAsar = asarOptions != null;
    await this.sanityCheckPackage(appOutDir, isAsar, framework);
    await this.signApp(packContext, isAsar);

    const afterSign = resolveFunction(this.config.afterSign, "afterSign");
    if (afterSign != null) await Promise.resolve(afterSign(packContext));
  }

  protected getCscLink(extraEnvName?: string | null): string | null | undefined {
    // allow to specify as empty string
    const envValue = chooseNotNull(extraEnvName == null ? null : process.env[extraEnvName], process.env.CSC_LINK);
    return chooseNotNull(chooseNotNull(this.info.config.cscLink, this.platformSpecificBuildOptions.cscLink), envValue);
  }

  protected getCscPassword(): string {
    const password = this.doGetCscPassword();
    if (isEmptyOrSpaces(password)) {
      log.info({ reason: "CSC_KEY_PASSWORD is not defined" }, "empty password will be used for code signing");
      return "";
    }
    return password.trim();
  }

  protected async getOrConvertIcon(format: IconFormat): Promise<string | null> {
    const result = await this.resolveIcon(
      asArray(this.platformSpecificBuildOptions.icon || this.config.icon),
      [],
      format,
    );
    if (result.length === 0) {
      const { framework } = this.info;
      if (framework.getDefaultIcon != null) return framework.getDefaultIcon(this.platform);

      log.warn(
        { reason: "application icon is not set" },
        `default ${capitalizeFirstLetter(framework.name)} icon is used`,
      );
      return this.getDefaultFrameworkIcon();
    }
    return result[0].file;
  }

  protected packageInDistributableFormat(
    appOutDir: string,
    arch: Arch,
    targets: Target[],
    taskManager: AsyncTaskManager,
  ): void {
    if (targets.find((it) => !it.isAsyncSupported) == null) {
      PlatformPackager.buildAsyncTargets(targets, taskManager, appOutDir, arch);
      return;
    }

    taskManager.add(async () => {
      // BluebirdPromise.map doesn't invoke target.build immediately, but for RemoteTarget it is very critical to call build() before finishBuild()
      const subTaskManager = new AsyncTaskManager(this.info.cancellationToken);
      PlatformPackager.buildAsyncTargets(targets, subTaskManager, appOutDir, arch);
      await subTaskManager.awaitTasks();

      for (const target of targets) if (!target.isAsyncSupported) await target.build(appOutDir, arch);
    });
  }

  // eslint-disable-next-line
  protected prepareAppInfo(appInfo: AppInfo) {
    return new AppInfo(this.info, null, this.platformSpecificBuildOptions);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected signApp(packContext: AfterPackContext, isAsar: boolean): Promise<any> {
    return Promise.resolve();
  }

  private async checkFileInPackage(resourcesDir: string, file: string, messagePrefix: string, isAsar: boolean) {
    const relativeFile = path.relative(this.info.appDir, path.resolve(this.info.appDir, file));
    if (isAsar) {
      await checkFileInArchive(path.join(resourcesDir, "app.asar"), relativeFile, messagePrefix);
      return;
    }

    const pathParsed = path.parse(file);
    // Even when packaging to asar is disabled, it does not imply that the main file can not be inside an .asar archive.
    // This may occur when the packaging is done manually before processing with deskgap-builder.
    if (pathParsed.dir.includes(".asar")) {
      // The path needs to be split to the part with an asar archive which acts like a directory and the part with
      // the path to main file itself. (e.g. path/arch.asar/dir/index.js -> path/arch.asar, dir/index.js)
      // noinspection TypeScriptValidateJSTypes
      const pathSplit: string[] = pathParsed.dir.split(path.sep);
      let partWithAsarIndex = 0;
      pathSplit.some((pathPart: string, index: number) => {
        partWithAsarIndex = index;
        return pathPart.endsWith(".asar");
      });
      const asarPath = path.join(...pathSplit.slice(0, partWithAsarIndex + 1));
      let mainPath =
        pathSplit.length > partWithAsarIndex + 1 ? path.join.apply(pathSplit.slice(partWithAsarIndex + 1)) : "";
      mainPath += path.join(mainPath, pathParsed.base);
      await checkFileInArchive(path.join(resourcesDir, "app", asarPath), mainPath, messagePrefix);
    } else {
      const fullPath = path.join(resourcesDir, "app", relativeFile);
      const outStat = await statOrNull(fullPath);
      if (outStat == null)
        throw new Error(`${messagePrefix} "${fullPath}" does not exist. Seems like a wrong configuration.`);
      // noinspection ES6MissingAwait
      else if (!outStat.isFile())
        throw new Error(`${messagePrefix} "${fullPath}" is not a file. Seems like a wrong configuration.`);
    }
  }

  private computeArtifactName(pattern: any, ext: string, arch: Arch | null | undefined): string {
    const archName = arch == null ? null : getArtifactArchName(arch, ext);
    return this.expandMacro(pattern, this.platform === Platform.MAC ? null : archName, {
      ext,
    });
  }

  private async computeAsarOptions(customBuildOptions: DC): Promise<AsarOptions | null> {
    if (!isDeskGapBased(this.info.framework)) return null;

    function errorMessage(name: string) {
      return `${name} is deprecated is deprecated and not supported — please use asarUnpack`;
    }

    const buildMetadata = this.config as any;
    if (buildMetadata["asar-unpack"] != null) throw new Error(errorMessage("asar-unpack"));

    if (buildMetadata["asar-unpack-dir"] != null) throw new Error(errorMessage("asar-unpack-dir"));

    const platformSpecific = customBuildOptions.asar;
    const result = platformSpecific == null ? this.config.asar : platformSpecific;
    if (result === false) {
      const appAsarStat = await statOrNull(path.join(this.info.appDir, "app.asar"));
      // noinspection ES6MissingAwait
      if (appAsarStat == null || !appAsarStat.isFile())
        log.warn(
          {
            solution: "enable asar and use asarUnpack to unpack files that must be externally available",
          },
          "asar usage is disabled — this is strongly not recommended",
        );

      return null;
    }

    if (result == null || result === true) return {};

    for (const name of ["unpackDir", "unpack"])
      if ((result as any)[name] != null) throw new Error(errorMessage(`asar.${name}`));

    return deepAssign({}, result);
  }

  private copyAppFiles(
    taskManager: AsyncTaskManager,
    asarOptions: AsarOptions | null,
    resourcePath: string,
    defaultDestination: string,
    packContext: AfterPackContext,
    platformSpecificBuildOptions: DC,
    excludePatterns: Minimatch[],
    macroExpander: (it: string) => string,
  ) {
    const { appDir } = this.info;
    const { config } = this;
    const isDeskGapCompile = asarOptions != null && isDeskGapCompileUsed(this.info);

    const mainMatchers = getMainFileMatchers(
      appDir,
      defaultDestination,
      macroExpander,
      platformSpecificBuildOptions,
      this,
      packContext.outDir,
      isDeskGapCompile,
    );
    if (excludePatterns.length > 0) for (const matcher of mainMatchers) matcher.excludePatterns = excludePatterns;

    const { framework } = this.info;
    const transformer = createTransformer(
      appDir,
      config,
      isDeskGapCompile
        ? {
            originalMain: this.info.metadata.main,
            main: ELECTRON_COMPILE_SHIM_FILENAME,
            ...config.extraMetadata,
          }
        : config.extraMetadata,
      framework.createTransformer == null ? null : framework.createTransformer(),
    );

    const _computeFileSets = (matchers: FileMatcher[]) => {
      return computeFileSets(matchers, this.info.isPrepackedAppAsar ? null : transformer, this, isDeskGapCompile).then(
        async (result) => {
          if (!this.info.isPrepackedAppAsar && !this.info.areNodeModulesHandledExternally) {
            const moduleFileMatcher = getNodeModuleFileMatcher(
              appDir,
              defaultDestination,
              macroExpander,
              platformSpecificBuildOptions,
              this.info,
            );
            result = result.concat(await computeNodeModuleFileSets(this, moduleFileMatcher));
          }
          return result.filter((it) => it.files.length > 0);
        },
      );
    };

    if (this.info.isPrepackedAppAsar)
      taskManager.addTask(
        BluebirdPromise.each(_computeFileSets([new FileMatcher(appDir, resourcePath, macroExpander)]), (it) =>
          copyAppFiles(it, this.info, transformer),
        ),
      );
    else if (asarOptions == null) {
      // for ASAR all asar unpacked files will be extra transformed (e.g. sign of EXE and DLL) later,
      // for prepackaged asar extra transformation not supported yet,
      // so, extra transform if asar is disabled
      const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext);
      const combinedTransformer: FileTransformer = (file) => {
        if (transformerForExtraFiles != null) {
          const result = transformerForExtraFiles(file);
          if (result != null) return result;
        }
        return transformer(file);
      };

      taskManager.addTask(
        BluebirdPromise.each(_computeFileSets(mainMatchers), (it) => copyAppFiles(it, this.info, combinedTransformer)),
      );
    } else {
      const unpackPattern = getFileMatchers(config, "asarUnpack", defaultDestination, {
        macroExpander,
        customBuildOptions: platformSpecificBuildOptions,
        globalOutDir: packContext.outDir,
        defaultSrc: appDir,
      });
      const fileMatcher = unpackPattern == null ? null : unpackPattern[0];
      taskManager.addTask(
        _computeFileSets(mainMatchers).then(async (fileSets) => {
          for (const fileSet of fileSets) await transformFiles(transformer, fileSet);

          await new AsarPackager(
            appDir,
            resourcePath,
            asarOptions,
            fileMatcher == null ? null : fileMatcher.createFilter(),
          ).pack(fileSets, this);
        }),
      );
    }
  }

  private getExtraFileMatchers(
    isResources: boolean,
    appOutDir: string,
    options: GetFileMatchersOptions,
  ): FileMatcher[] | null {
    const base = isResources
      ? this.getResourcesDir(appOutDir)
      : this.platform === Platform.MAC
      ? path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents")
      : appOutDir;
    return getFileMatchers(this.config, isResources ? "extraResources" : "extraFiles", base, options);
  }

  private async sanityCheckPackage(appOutDir: string, isAsar: boolean, framework: Framework): Promise<any> {
    const outStat = await statOrNull(appOutDir);
    if (outStat == null)
      throw new Error(`Output directory "${appOutDir}" does not exist. Seems like a wrong configuration.`);
    // noinspection ES6MissingAwait
    else if (!outStat.isDirectory())
      throw new Error(`Output directory "${appOutDir}" is not a directory. Seems like a wrong configuration.`);

    const resourcesDir = this.getResourcesDir(appOutDir);
    const mainFile =
      (framework.getMainFile == null ? null : framework.getMainFile(this.platform)) ||
      this.info.metadata.main ||
      "index.js";
    await this.checkFileInPackage(resourcesDir, mainFile, "Application entry file", isAsar);
    await this.checkFileInPackage(resourcesDir, "package.json", "Application", isAsar);
  }
}

export interface IconInfo {
  file: string;
  size: number;
}

interface IconConvertResult {
  error?: string;
  errorCode?: string;
  icons?: IconInfo[];
  isFallback?: boolean;
}

export type IconFormat = "icns" | "ico" | "set";

export function isSafeGithubName(name: string) {
  return /^[0-9A-Za-z._-]+$/.test(name);
}

export function computeSafeArtifactNameIfNeeded(
  suggestedName: string | null,
  safeNameProducer: () => string,
): string | null {
  // GitHub only allows the listed characters in file names.
  if (suggestedName != null) {
    if (isSafeGithubName(suggestedName)) return null;

    // prefer to use suggested name - so, if space is the only problem, just replace only space to dash
    suggestedName = suggestedName.replace(/ /g, "-");
    if (isSafeGithubName(suggestedName)) return suggestedName;
  }

  return safeNameProducer();
}

// remove leading dot
export function normalizeExt(ext: string) {
  return ext.startsWith(".") ? ext.substring(1) : ext;
}

export function resolveFunction<T>(executor: T | string, name: string): T {
  if (executor == null || typeof executor !== "string") return executor;

  let p = executor as string;
  if (p.startsWith(".")) p = path.resolve(p);

  try {
    p = require.resolve(p);
  } catch (e) {
    debug(e);
    p = path.resolve(p);
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require(p);
  const namedExport = m[name];
  if (namedExport == null) return m.default || m;

  return namedExport;
}

export function chooseNotNull(v1: string | null | undefined, v2: string | null | undefined): string | null | undefined {
  return v1 == null ? v2 : v1;
}

function capitalizeFirstLetter(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function isSafeToUnpackDeskGapOnRemoteBuildServer(packager: PlatformPackager<any>) {
  if (packager.platform !== Platform.LINUX || packager.config.remoteBuild === false) return false;

  if (process.platform === "win32" || isEnvTrue(process.env._REMOTE_BUILD))
    return packager.config.deskgapDist == null && packager.config.deskgapDownload == null;

  return false;
}
