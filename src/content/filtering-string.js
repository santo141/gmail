// @flow

import { isEqual } from 'lodash';

import type { IndexIntoStackTable } from '../common/types/profile';
import type { ImplementationFilter } from './actions/types';

export type FilterDescription = {|
  implementation: ImplementationFilter,
  substrings: string[],
  paths: string[],
|};

export type ChargeDescription = {|
  source: IndexIntoStackTable,
  target: IndexIntoStackTable,
|};

export type Filter = {|
  include: FilterDescription | null,
  exclude: FilterDescription | null,
  display: {|
    invertCallstack: boolean,
    hidePlatformDetails: boolean,
    hide: IndexIntoStackTable[],
    charge: ChargeDescription[],
  |},
  cachedString: string,
|};

function _fromFilterDescription(filter: FilterDescription): string[] {
  const result = [];

  if (filter.implementation) {
    result.push(`implementation:${filter.implementation}`);
  }

  result.push(...filter.paths.map(path => `path:${path}`));
  result.push(...filter.substrings.map(string => `substring:${string}`));

  return result;
}

export function stringFromFilter(filter: Filter | null = null): string {
  if (!filter) {
    return '';
  }

  if (isEqual(filter, filterFromString(filter.cachedString))) {
    return filter.cachedString;
  }

  const result = [];
  if (filter.include) {
    result.push(..._fromFilterDescription(filter.include));
  }

  if (filter.exclude) {
    const excludedItems = _fromFilterDescription(filter.exclude).map(item => `-${item}`);
    result.push(...excludedItems);
  }

  const display = filter.display;
  if (display.invertCallstack) {
    result.push('invertCallstack');
  }
  if (display.hidePlatformDetails) {
    result.push('hidePlatformDetails');
  }
  result.push(...display.hide.map(index => `hide:${index}`));
  result.push(...display.charge.map(({ source, target }) => `charge:${source}:${target}`));

  return result.join(' ');
}

export function getEmptyUserFilter(): Filter {
  return {
    include: null,
    exclude: null,
    display: {
      invertCallstack: false,
      hidePlatformDetails: false,
      hide: [],
      charge: [],
    },
    cachedString: '',
  };
}

/* This regular expression matches strings like `verb:argument`, where the
 * argument can be missing, and with an optional prefix + or -. The optional
 * argument can be any character but spaces (eg: a path with /), including
 * colons as well like with the charge filter.
 */
const reFilterFromString = /([-+])?\b(\w+)(?::(\S+))?/g;
const reChargeArgument = /^(\d+):(\d+)$/;

export function filterFromString(string: string = ''): Filter {
  let searchResult;

  const filter: Filter = getEmptyUserFilter();
  filter.cachedString = string;

  while ((searchResult = reFilterFromString.exec(string)) !== null) {
    const [, modifier, verb, argument] = (searchResult: string[]);
    const operation = modifier === '-' ? 'exclude' : 'include';
    const filterDescription = (): FilterDescription => (filter[operation] = filter[operation] || {
      implementation: null,
      paths: [],
      substrings: [],
    });

    switch (verb.toLowerCase()) {
      case 'invertcallstack':
        filter.display.invertCallstack = true;
        break;
      case 'hideplatformdetails':
        filter.display.hidePlatformDetails = true;
        break;
      case 'hide':
        filter.display.hide.push(+argument);
        break;
      case 'charge': {
        const chargeResult: string[] = reChargeArgument.exec(argument);
        if (chargeResult) {
          filter.display.charge.push({ source: +chargeResult[1], target: +chargeResult[2] });
        }
        break;
      }
      case 'implementation':
        if (argument === 'js' || argument === 'cpp') {
          filterDescription().implementation = argument;
        }
        break;
      case 'path':
        filterDescription().paths.push(argument);
        break;
      case 'substring':
      default: {
        const string = argument || verb;
        filterDescription().substrings.push(string);
        break;
      }
    }
  }

  return filter;
}
