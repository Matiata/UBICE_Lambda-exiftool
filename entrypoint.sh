#!/bin/bash

# $ variables defined in .docker.env

# Install perl
# curl $PERL_URL | tar xz
# cd perl-*
# make
# make install
# cd ..

# Install exiftool
curl $EXIFTOOL_URL
gzip -dc Image-ExifTool-12.81.tar.gz | tar -xf -
cd ./Image-ExifTool*
perl Makefile.PL
make install
