#!/usr/bin/env bash
# Installs the command line tool of Mortise from a release of mortise-dev/mortise:
# finds the tag, picks the archive of the runner, checks its SHA-256 against the sums file of the
# release, unpacks it and adds its folder to PATH. main.js runs it with bash on Linux, macOS and
# Windows (Git Bash).
#
# Environment: INPUT_VERSION (latest, vX.Y.Z or X.Y.Z), INPUT_TOKEN (optional, for the GitHub API),
# and the variables of the runner: RUNNER_OS, RUNNER_ARCH, RUNNER_TEMP, GITHUB_PATH, GITHUB_OUTPUT,
# GITHUB_STATE.
# SETUP_MORTISE_BASE_URL replaces the download address for the tests of this repository.
set -euo pipefail

repo=mortise-dev/mortise
base=${SETUP_MORTISE_BASE_URL:-https://github.com/$repo/releases/download}

fail() {
  echo "::error::$1"
  exit 1
}

temp=$RUNNER_TEMP
if [ "$RUNNER_OS" = Windows ]; then temp=$(cygpath -u "$RUNNER_TEMP"); fi

# The tag. The newest release comes from the GitHub API; the token goes to curl on standard input,
# so it is not on a command line.
version=${INPUT_VERSION:-latest}
if [ "$version" = latest ]; then
  answer=$(
    {
      echo 'header = "Accept: application/vnd.github+json"'
      if [ -n "${INPUT_TOKEN:-}" ]; then printf 'header = "Authorization: Bearer %s"\n' "$INPUT_TOKEN"; fi
    } | curl --config - --fail --silent --show-error --location --retry 3 \
      "https://api.github.com/repos/$repo/releases/latest"
  ) || fail "The GitHub API did not give the latest release of $repo. Set the input version, such as v0.3.0, or pass a token."
  version=$(sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' <<<"$answer" | head -n 1)
  if [ -z "$version" ]; then fail "The answer of the GitHub API for the latest release of $repo has no tag. Set the input version."; fi
fi
number=${version#v}
if ! [[ $number =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "The version '$version' is not latest, vX.Y.Z or X.Y.Z."
fi
tag=v$number

# The archive of the runner. The names are those of the Installers workflow of mortise-dev/mortise.
binary=mortise
case "$RUNNER_OS/$RUNNER_ARCH" in
  Linux/X64) platform=linux-x86_64.tar.gz ;;
  Linux/ARM64) platform=linux-arm64.tar.gz ;;
  macOS/ARM64) platform=macos-arm64.zip ;;
  Windows/X64)
    platform=windows-x64.zip
    binary=mortise.exe
    ;;
  *) fail "Mortise has no binary for $RUNNER_OS on $RUNNER_ARCH. Install it with: cargo install --locked mortise-cli" ;;
esac
archive="mortise-$tag-$platform"
sums="Mortise-$tag-SHA256SUMS.txt"

download=$(mktemp -d "$temp/setup-mortise-download.XXXXXX")
trap 'rm -rf "$download"' EXIT
fetch() {
  curl --fail --silent --show-error --location --retry 3 --output "$download/$1" "$base/$tag/$1" ||
    fail "Could not download $1 of release $tag from $base/$tag. Check that the release exists and carries the command line tool."
}
echo "Downloading $archive of $repo $tag."
fetch "$archive"
fetch "$sums"

# The line of the archive in the sums file, as sha256sum writes it: the sum, then the name.
expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print tolower($1) }' "$download/$sums")
if [ -z "$expected" ] || [ "$(grep -c . <<<"$expected")" -ne 1 ]; then
  fail "$sums of release $tag has no single line for $archive."
fi
if command -v sha256sum > /dev/null; then
  actual=$(sha256sum "$download/$archive" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$download/$archive" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  fail "The SHA-256 of $archive is $actual, but $sums of release $tag says $expected. The download is not the published file; nothing was installed."
fi
echo "SHA-256 of $archive matches $sums: $actual"

install="$temp/setup-mortise/$tag"
rm -rf "$install"
mkdir -p "$install"
case "$archive" in
  *.tar.gz) tar -xzf "$download/$archive" -C "$install" ;;
  *.zip)
    if command -v unzip > /dev/null; then
      unzip -q -o "$download/$archive" -d "$install"
    else
      7z x -y -bso0 -bsp0 "-o$(cygpath -w "$install")" "$(cygpath -w "$download/$archive")"
    fi
    ;;
esac
if [ ! -f "$install/$binary" ]; then fail "$archive holds no $binary at its top level."; fi
chmod +x "$install/$binary"

printed=$("$install/$binary" --version)
if [ "$printed" != "mortise $number" ]; then
  fail "$archive holds a binary that prints '$printed' for --version, not 'mortise $number'."
fi

if [ "$RUNNER_OS" = Windows ]; then
  cygpath -w "$install" >> "$GITHUB_PATH"
  installed=$(cygpath -w "$install/$binary")
else
  echo "$install" >> "$GITHUB_PATH"
  installed=$install/$binary
fi
echo "version=$tag" >> "$GITHUB_OUTPUT"
# For the post step (post.js), which finds this binary whatever the job did to PATH.
{
  echo "mortise=$installed"
  echo "version=$tag"
} >> "$GITHUB_STATE"
echo "Installed $printed in $install."
