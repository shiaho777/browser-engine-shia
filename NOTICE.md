THIRD-PARTY NOTICES
===================

browser-engine-shia incorporates data derived from the following third-party
projects. The engine's own source code remains MIT-licensed (see LICENSE);
this file records the attribution required by each source project's license.

Ladybird Browser
----------------
Source: https://github.com/LadybirdBrowser/ladybird
License: BSD 2-Clause License
Copyright (c) 2018-present, the Ladybird developers. All rights reserved.

Derived artifacts in this repository:

  - packages/generator/src/generated/ladybird-properties.data.ts
    CSS property metadata (names, initial values, inheritance, animation
    types, valid-types/valid-identifiers vocabularies, shorthand longhands,
    quirks and affects-* flags) derived from
    Libraries/LibWeb/CSS/Properties.json by
    tools/ladybird-import/import-properties.mjs.

  - packages/generator/src/generated/ladybird-idl.data.ts (if present)
    WebIDL interface data derived from Libraries/LibWeb/**\/*.idl by
    tools/ladybird-import/import-idl.mjs.

  - wpt-imported/ (if present)
    Web Platform Tests cases vendored via Ladybird's Tests/LibWeb/wpt-import
    tree. WPT itself is distributed under the W3C 3-clause BSD license;
    see https://github.com/web-platform-tests/wpt for details.

The full BSD 2-Clause license text is available in the source repository
linked above and is reproduced here:

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

  1. Redistributions of source code must retain the above copyright notice,
     this list of conditions and the following disclaimer.

  2. Redistributions in binary form must reproduce the above copyright
     notice, this list of conditions and the following disclaimer in the
     documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
  LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
  CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
  SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
  INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
  CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
  POSSIBILITY OF SUCH DAMAGE.
