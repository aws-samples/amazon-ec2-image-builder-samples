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

# login
get_token ()
{
  local TOKEN=$(curl -s -S -X POST $ORCA_API_SERVER/api/user/session \
                      -H "accept: application/json" -H "Content-Type: application/json" \
                      -d "{ \"security_token\": \"$SECURITY_TOKEN\"}" | ./jq -r .jwt.access)

  if [[ "$TOKEN" == null ]]; then
    echo "failed to get token"
    exit 1
  fi
  echo $TOKEN
}

JWT_TOKEN=$(get_token)
GET_TOKEN_EXIT_CODE=$?
(( ${GET_TOKEN_EXIT_CODE} == 0 )) || (echo "$JWT_TOKEN" && exit 1)

SCAN_UNIQUE_ID=$(curl -s -S -X POST -H "Authorization: Bearer $JWT_TOKEN" $ORCA_API_SERVER/api/scan/asset/vm/$ACCOUNT_ID/$INSTANCE_ID?intermediate=true | ./jq -r .scan_unique_id)

echo "Scan started. Scan id: '${SCAN_UNIQUE_ID}'"

# scan status polling
get_status ()
{
  local SCAN_STATUS_RESPONSE=$(curl -s -S -X GET -H "Authorization: Bearer $JWT_TOKEN" $ORCA_API_SERVER/api/scan/status/$SCAN_UNIQUE_ID)
  local HAS_RESPONSE_CODE=$(./jq -r 'has("code")' <<< "$SCAN_STATUS_RESPONSE")
  local RESPONSE_CODE=$(./jq -r '.code' <<< "$SCAN_STATUS_RESPONSE")

  # if the token expired, get a new one
  if [[ $HAS_RESPONSE_CODE && "$RESPONSE_CODE" == *"token_not_valid"* ]]; then
    JWT_TOKEN=$(get_token)
    GET_TOKEN_EXIT_CODE=$?
    (( ${GET_TOKEN_EXIT_CODE} == 0 )) || (echo "$JWT_TOKEN" && exit 1)

    SCAN_STATUS_RESPONSE=$(curl -s -S -X GET -H "Authorization: Bearer $JWT_TOKEN" $ORCA_API_SERVER/api/scan/status/$SCAN_UNIQUE_ID)
  fi

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
JWT_TOKEN=$(get_token)
ASSET_SCORE=$(curl -s -S -X GET -H "Authorization: Bearer $JWT_TOKEN" $ORCA_API_SERVER/api/assets/vm_$ACCOUNT_ID\_$INSTANCE_ID | ./jq -r .state.score)
echo $ASSET_SCORE > $LOG_FILE_PATH
