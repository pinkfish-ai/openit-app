#!/bin/bash

# Generate TypeScript APIs for openit-app from Pinkfish service specs
# Usage: ./scripts/generate-typescript-api.sh <service>
# Services: platform, firebase-helpers, pinkfish-connections

set -e

# Check if PINKFISH_DEV_DIR is set
if [ -z "$PINKFISH_DEV_DIR" ]; then
  echo "Error: PINKFISH_DEV_DIR environment variable is not set"
  echo "Set it with: export PINKFISH_DEV_DIR=/Users/[your-username]/Documents/GitHub"
  exit 1
fi

# Check if service argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <service>"
  echo "Services: platform, firebase-helpers, pinkfish-connections"
  exit 1
fi

SERVICE=$1
dev_dir=$PINKFISH_DEV_DIR
openit_generated_dir="$(dirname "$0")/../src/api/generated/"
service_spec_dir="$dev_dir/$SERVICE/spec"

echo "Generating TypeScript API for $SERVICE..."
echo "Dev directory: $dev_dir"
echo "Service spec: $service_spec_dir"
echo "Output directory: $openit_generated_dir"

# Verify the service spec directory exists
if [ ! -d "$service_spec_dir" ]; then
  echo "Error: Service spec directory not found at $service_spec_dir"
  exit 1
fi

# Create output directory if it doesn't exist
mkdir -p "$openit_generated_dir"

# Map service to spec directory and generated module name
case "$SERVICE" in
  platform)
    spec_module="platform-app"
    ;;
  firebase-helpers)
    spec_module="firebase-helpers"
    ;;
  pinkfish-connections)
    spec_module="pink-connect"
    ;;
  *)
    echo "Error: Unknown service '$SERVICE'"
    echo "Valid services: platform, firebase-helpers, pinkfish-connections"
    exit 1
    ;;
esac

# Clean up old generated files
output_dir="$openit_generated_dir/$spec_module"
if [ -d "$output_dir" ]; then
  echo "Cleaning existing generated files in $output_dir..."
  rm -rf "$output_dir"
fi

# Compile TypeSpec
echo "Compiling TypeSpec for $SERVICE..."
cd "$service_spec_dir"
npm install > /dev/null 2>&1 || true
npx tsp compile . --output-dir ./dist > /dev/null 2>&1 || {
  echo "Error: TypeSpec compilation failed"
  exit 1
}

# Generate TypeScript API
echo "Generating TypeScript API client..."
cd "$dev_dir/openit-app"

# Find the openapi file (yaml or json)
openapi_file="$service_spec_dir/dist/@typespec/openapi3/openapi.yaml"
if [ ! -f "$openapi_file" ]; then
  openapi_file="$service_spec_dir/dist/openapi.json"
  if [ ! -f "$openapi_file" ]; then
    echo "Error: openapi.yaml or openapi.json not found"
    exit 1
  fi
fi

# Generate using OpenAPI Generator
openapi-generator-cli generate \
  -i "$openapi_file" \
  -g typescript-fetch \
  -o "$output_dir" \
  --additional-properties=enumPropertyNaming=UPPERCASE \
  --skip-validate-spec > /dev/null 2>&1 || {
  echo "Error: OpenAPI Generator failed"
  exit 1
}

echo "✓ API generated successfully at $output_dir"
echo ""
echo "Generated files:"
echo "  - APIs: $output_dir/apis/"
echo "  - Models: $output_dir/models/"
echo "  - $output_dir/index.ts"
echo "  - $output_dir/runtime.ts"
