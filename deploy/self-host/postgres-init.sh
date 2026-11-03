#!/bin/sh
# First start of the bundled Postgres only (an empty data volume): the roles procura
# expects (D-024, packages/db/README.md) and its database.
#   cairnmcp_app     group role the migrations grant privileges to; never logs in
#   cairnmcp_owner   owns the database and runs the migrations; not a superuser
#   cairnmcp_server  what the app connects as; can't bypass row-level security
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$PROCURA_POSTGRES_PASSWORD" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE cairnmcp_app NOLOGIN NOBYPASSRLS;
CREATE ROLE cairnmcp_owner LOGIN NOBYPASSRLS PASSWORD :'pw';
CREATE ROLE cairnmcp_server LOGIN NOBYPASSRLS PASSWORD :'pw' IN ROLE cairnmcp_app;
CREATE DATABASE procura OWNER cairnmcp_owner;
SQL
