import { InvalidConfigurationError, isEmptyOrSpaces } from "builder-util";
import { SpacesOptions } from "builder-util-runtime";
import { PublishContext } from "deskgap-publish";
import { BaseS3Publisher } from "./BaseS3Publisher";

export default class SpacesPublisher extends BaseS3Publisher {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async checkAndResolveOptions(
    options: SpacesOptions,
    channelFromAppVersion: string | null,
    errorIfCannot: boolean,
  ) {
    if (options.name == null)
      throw new InvalidConfigurationError(
        `Please specify "name" for "spaces" publish provider (see https://www.deskgap.build/configuration/publish#spacesoptions)`,
      );

    if (options.region == null)
      throw new InvalidConfigurationError(
        `Please specify "region" for "spaces" publish provider (see https://www.deskgap.build/configuration/publish#spacesoptions)`,
      );

    if (options.channel == null && channelFromAppVersion != null) options.channel = channelFromAppVersion;
  }

  readonly providerName = "Spaces";

  constructor(context: PublishContext, private readonly info: SpacesOptions) {
    super(context, info);
  }

  protected configureS3Options(args: string[]): void {
    super.configureS3Options(args);

    args.push("--endpoint", `${this.info.region}.digitaloceanspaces.com`);
    args.push("--region", this.info.region);

    const accessKey = process.env.DO_KEY_ID;
    const secretKey = process.env.DO_SECRET_KEY;
    if (isEmptyOrSpaces(accessKey))
      throw new InvalidConfigurationError(
        "Please set env DO_KEY_ID (see https://www.deskgap.build/configuration/publish#spacesoptions)",
      );

    if (isEmptyOrSpaces(secretKey))
      throw new InvalidConfigurationError(
        "Please set env DO_SECRET_KEY (see https://www.deskgap.build/configuration/publish#spacesoptions)",
      );

    args.push("--accessKey", accessKey);
    args.push("--secretKey", secretKey);
  }

  protected getBucketName(): string {
    return this.info.name;
  }
}
