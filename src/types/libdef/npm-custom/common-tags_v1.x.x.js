/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

declare module 'common-tags' {
  declare function oneLine(
    template: string[],
    ...expressions: string[]
  ): string;

  declare function oneLineTrim(
    template: string[],
    ...expressions: string[]
  ): string;

  declare function stripIndent(
    template: string[],
    ...expressions: string[]
  ): string;
}
