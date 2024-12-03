# Processed and Gecko Profile Format Changelog

This file documents all changes in the profiler gecko and processed formats.

Note that this is not an exhaustive list. Processed profile format upgraders can be found in [processed-profile-versioning.js](../src/profile-logic/processed-profile-versioning.js) and gecko profile format upgraders can be found in [gecko-profile-versioning.js](../src/profile-logic/gecko-profile-versioning.js). Please refer to them for older upgraders or for exact implementations.

## Processed profile format

### Version 52

Counters contain a new boolean field `relative`. It is true of the samples
in the counter are relative measuments to the previous count, the first
sample is 0, the absolute value is unknown.

### Version 51

Two new marker schema field format types have been added: `flow-id` and `terminating-flow-id`, with string index values (like `unique-string`).
An optional `isStackBased` boolean field has been added to the marker schema.

### Version 50

The serialized format can now optionally store sample and counter sample times as time deltas instead of absolute timestamps to reduce the JSON size. The unserialized version is unchanged.

### Version 49

A new `sanitized-string` marker schema format type has been added, allowing markers to carry arbitrary strings containing PII that will be sanitized along with URLs and FilePaths.

### Version 48

Removed the 'sampleGroups' object from the Counter structure.

### Version 47

The `pid` field of the `Thread` type is changed from `string | number` to `string`. The same happened to the `data.otherPid` field of IPC markers, and to the pid fields in the `profiler.counters` and `profile.profilerOverhead` lists.

### Version 46

An `isMainThread` field was added to the Thread type.

This replaces the following function:

```js
export function isMainThread(thread: Thread): boolean {
  return (
    thread.name === 'GeckoMain' ||
    // If the pid is a string, then it's not one that came from the system.
    // These threads should all be treated as main threads.
    typeof thread.pid === 'string' ||
    // On Linux the tid of the main thread is the pid. This is useful for
    // profiles imported from the Linux 'perf' tool.
    String(thread.pid) === thread.tid
  );
}
```

### Version 45

The `optimizations` field is removed from the `frameTable`.

### Version 44

The `searchable` property is implemented in the marker schema. Previously all the `name` and `category` marker schema properties were automatically searchable and we had manual handling for `FileIO`, `Log`, `DOMEvent`, `TraceEvent` marker types.

### Version 43

The `number` property in counters is now optional.

### Version 42

The `nativeSymbols` table now has a new column: `functionSize`. Its values can be null.

### Version 41

The `libs` list has moved from `Thread` to `Profile` - it is now shared between all threads in the profile. And it only contains libs which are used by at least one resource.

The Lib fields have changed, too:

- The `start`/`end`/`offset` fields are gone: They are not needed after profile processing, when all frame addresses have been made library-relative; and these values usually differ in the different processes, so the fields could not have a meaningful value in the shared list.
- There is a `codeId` field which defaults to `null`. This will be used in the future to store another ID which lets the symbol server look up correct binary. On Windows this is the dll / exe CodeId, and on Linux and Android this is the full ELF build ID.

We've also cleaned up the ResourceTable format:

- All resources now have names.
- Resources without a `host` or `lib` field have these fields set to `null` consistently.

### Older Versions

Older versions are not documented in this changelog but can be found in [processed-profile-versioning.js](../src/profile-logic/processed-profile-versioning.js).

## Gecko profile format

### Version 32

The memory counters are now named "malloc-relative" or "malloc-absolute"
rather than "malloc" (which were all previously relative)

### Version 31

Two new marker schema field format types have been added: `flow-id` and `terminating-flow-id`, with string index values (like `unique-string`).
An optional `isStackBased` boolean field has been added to the marker schema.

### Version 30

A new `sanitized-string` marker schema format type has been added, allowing markers to carry arbitrary strings containing PII that will be sanitized along with URLs and FilePaths.

### Version 29

Removed the 'sample_groups' object from the GeckoCounter structure.

### Version 28

A new `unique-string` marker schema format type has been added, allowing markers to carry unique-strings in their payloads.

### Version 27

The `optimizations` field is removed from the `frameTable` schema.

### Version 26

The `searchable` property is implemented in the marker schema. Previously all the `name` and `category` marker schema properties were automatically searchable and we had manual handling for `FileIO`, `Log`, `DOMEvent`, `TraceEvent` marker types.

### Older Versions

Older versions are not documented in this changelog but can be found in [gecko-profile-versioning.js](../src/profile-logic/gecko-profile-versioning.js).
