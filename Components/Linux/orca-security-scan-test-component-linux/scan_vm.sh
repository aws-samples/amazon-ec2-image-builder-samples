#!/bin/bash

ORCA_API_SERVER="${1}"
ACCOUNT_ID="${2}"
INSTANCE_ID="${3}"
SECURITY_TOKEN="${4}"
LOG_FILE_PATH="${5}"
DEBUG_MODE_ON="${6}"

if (( ${#DEBUG_MODE_ON} )); then
  set -xe
fi


SCAN_UNIQUE_ID=$(curl -s -S -X POST -H "Authorization: Token $SECURITY_TOKEN" $ORCA_API_SERVER/api/scan/asset/vm/$ACCOUNT_ID/$INSTANCE_ID?intermediate=true | ./jq -r .scan_unique_id)

echo "Scan started. Scan id: '${SCAN_UNIQUE_ID}' with api token"

# scan status polling
get_status ()
{
  local SCAN_STATUS_RESPONSE=$(curl -s -S -X GET -H "Authorization: Token $SECURITY_TOKEN" $ORCA_API_SERVER/api/scan/status/$SCAN_UNIQUE_ID)
  local SCAN_STATUS=$(./jq -r '.status' <<< "$SCAN_STATUS_RESPONSE")

  echo $SCAN_STATUS
}

STATUS=$(get_status)

while [[ "$STATUS" && "$STATUS" != "done" ]]
do
  echo "scanning still in progress..."
  sleep 30
  STATUS=$(get_status)
done

# get asset score
ASSET_SCORE=$(curl -s -S -X GET -H "Authorization: Token $SECURITY_TOKEN" $ORCA_API_SERVER/api/assets/vm_$ACCOUNT_ID\_$INSTANCE_ID | ./jq -r .state.score)
echo $ASSET_SCORE > $LOG_FILE_PATH
