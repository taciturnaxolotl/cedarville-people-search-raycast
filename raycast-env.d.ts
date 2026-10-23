/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-directory` command */
  export type SearchDirectory = ExtensionPreferences & {
  /** Data Source - Where searches go. The engine needs no browser sign-in. */
  "source": "engine" | "portal",
  /** Engine URL - Base URL of the cedarengine server */
  "apiUrl": string,
  /** Engine Token - The server's BEARER_TOKEN */
  "apiToken"?: string,
  /** Demo Mode - Redact personal information for screenshots and demos */
  "demoMode": boolean
}
}

declare namespace Arguments {
  /** Arguments passed to the `search-directory` command */
  export type SearchDirectory = {}
}

