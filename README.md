# Croquet DocView

## Introduction

The Croquet DocView allows a group of users to view a PDF file collaboratively. A user can drop a PDF file into the area, and then the scroll position and scale are shared among participants. Care is taken so that multiple users cannot jump around different places at the same time.

## Code Organization

The DocView implementation uses [PDF.js](https://mozilla.github.io/pdf.js/) from Mozilla, with some with some customisations to suit docview's purposes. The `pdf.js` directory holds a pre-built version of the customized `pdf.js`. All other code is in pdf-viewer.js, which is loaded from `index.html`.

## Rebuilding PDF.js

If you would like to rebuilt pdf.js.  Follow the steps described below:

* clone our fork of the pdf.js repository (https://github.com/aranlunzer/pdf.js-croquet.git)

* in the top directory of that repository, run

    gulp minified

    (note: the build sometimes halts due to failing to clear working directories.  Just rerun.)

* copy the updated "build" and "web" directories from the pdf.js repository's /build/minified into the pdf.js directory here, overwriting the directories from the pre-built version

## Rebuilding and Testing DocView

To rebuild the viewer, incorporating changes to its source or to the pdf.js build, run

    ./build.sh

This will place a minified pdf-viewer.js and the relevant pdf.js libraries in dist/.  You can then test by running a local server and loading dist/index.html.
