#!/bin/bash
cd `dirname "$0"`

npm ci

rm -rf dist/*
npm run build || exit
rm dist/*.js.map
mkdir dist/build
cp pdf.js/build/*.js dist/build
cp -R pdf.js/web dist/
