#!/bin/bash
# Setup script for reputation system database

set -e

echo "=========================================="
echo "VeriNode Reputation System - DB Setup"
echo "=========================================="
echo ""

# Database configuration
DB_HOST="${TEST_DB_HOST:-localhost}"
DB_PORT="${TEST_DB_PORT:-5432}"
DB_USER="${TEST_DB_USER:-postgres}"
DB_NAME="${TEST_DB_NAME:-verinode_test}"

echo "Database Configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  User: $DB_USER"
echo "  Database: $DB_NAME"
echo ""

# Check if database exists
echo "Checking if database exists..."
DB_EXISTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -lqt | cut -d \| -f 1 | grep -w "$DB_NAME" | wc -l)

if [ "$DB_EXISTS" -eq 0 ]; then
    echo "Creating database $DB_NAME..."
    createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
    echo "✓ Database created"
else
    echo "✓ Database already exists"
fi

echo ""
echo "Running reputation schema migration..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f src/database/migrations/005_reputation_schema.sql

echo ""
echo "Verifying tables..."
TABLE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('reputations', 'reputation_events')")

if [ "$TABLE_COUNT" -eq 2 ]; then
    echo "✓ Tables created successfully"
    echo ""
    echo "Tables:"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "\dt reputation*"
    echo ""
    echo "Indexes:"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "\di idx_reputation*"
else
    echo "✗ Table creation failed"
    exit 1
fi

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Run tests with:"
echo "  npm run test:reputation"
echo ""
echo "Or directly:"
echo "  npx ts-node tests/reputation_scoreService.test.ts"
echo ""
