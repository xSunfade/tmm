#!/bin/bash
# Post-deploy hook to ensure database is initialized
# This script runs after deployment to verify database setup

echo "Running post-deploy database initialization..."

# Database will be auto-created on first server start
# This script just verifies the directory exists and is writable

DB_DIR="/tmp"
if [ -n "$DB_PATH" ]; then
  DB_DIR=$(dirname "$DB_PATH")
fi

# Ensure directory exists and is writable
mkdir -p "$DB_DIR"
chmod 755 "$DB_DIR"

echo "Database directory ready: $DB_DIR"
echo "Database will be created automatically on server start if it doesn't exist"

