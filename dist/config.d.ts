export interface UserConfig {
    defaultModel?: string;
    defaultProvider?: string;
}
export declare function configPath(): string;
export declare function readUserConfig(): Promise<UserConfig>;
export declare function writeUserConfig(config: UserConfig): Promise<void>;
export declare function updateUserConfig(patch: UserConfig): Promise<UserConfig>;
export declare function resolveConfiguredModel(cliModel: string | undefined, config: UserConfig): string;
