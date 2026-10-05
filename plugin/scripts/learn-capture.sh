#!/bin/bash
# Compatibility entry; native registrations use the bounded Node body on both hosts.
exec node "$(dirname "$0")/learn-capture.mjs"
