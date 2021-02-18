#!/usr/bin/env bash

# Requirements
# - curl

usage()
{
  exit_code="${1}"
  message="${2}"

  echo "${message}"
  cat <<EOF
Usage: $(basename ${0}) --api-key API_KEY [options]

options:

  -h, --help                        print help message and exit
  -s, --score-threshold SCORE       the score below which the test will fail, valid range is 1-4 [default: 2]
  -t, --timeout TIMEOUT             the timeout for the scan in seconds [default: 1800]
  -d, --debug                       debug mode [default: off]
EOF

  exit "${exit_code}"
}

# default values
TIMEOUT_SEC=1800
SCORE_THRESHOLD=2

while (( ${#} ))
do
  case "${1}" in
    -h|--help)
      usage 0
      ;;
    --api-key)
      (( ${#} > 1 )) || usage 1 "ERROR: option ${1} requires an argument"
      shift
      API_KEY="${1}"
      ;;
    -s|--score-threshold)
      (( ${#} > 1 )) || usage 1 "ERROR: option ${1} requires an argument"
      shift
      SCORE_THRESHOLD="${1}"
      if ! [[ $SCORE_THRESHOLD =~ ^[1-4]{1}$ ]]; then
        echo "ERROR: score threshold must be in range [1-4]"
        exit 1
      fi
      ;;
    -t|--timeout)
      (( ${#} > 1 )) || usage 1 "ERROR: option ${1} requires an argument"
      shift
      TIMEOUT_SEC="${1}"
      if [[ $TIMEOUT_SEC =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: timeout parameter must be a positive number"
        exit 1
      fi
      ;;
    -d|--debug)
      DEBUG_MODE_ON=true
      ;;
    *)
      usage 1 "Unknown argument '${1}'"
      ;;
  esac

  shift
done

(( ${#API_KEY} )) || usage 1 "ERROR: --api-key is required"

# download jq
curl -o jq -L https://github.com/stedolan/jq/releases/download/jq-1.6/jq-linux64
chmod +x jq

# create a log file
LOG_FILE_PATH=$(mktemp)
trap "{ rm -f $LOG_FILE_PATH; }" EXIT

# initialize metadata
REGION=$(curl http://169.254.169.254/latest/dynamic/instance-identity/document | ./jq -r .region)
ACCOUNT_ID=$(curl http://169.254.169.254/latest/dynamic/instance-identity/document | ./jq -r .accountId)
INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id)

case "${REGION}" in
  us*)
    ORCA_API_SERVER='https://app.us.orcasecurity.io'
    ;;
  eu*)
    ORCA_API_SERVER='https://app.eu.orcasecurity.io'
    ;;
  *)
    echo "Unsupported region"
    exit 1
    ;;
esac

# scan status polling
timeout $TIMEOUT_SEC bash ./scan_vm.sh "$ORCA_API_SERVER" "$ACCOUNT_ID" "$INSTANCE_ID" "$API_KEY" "$LOG_FILE_PATH" "$DEBUG_MODE_ON"
EXIT_CODE=$?

if (( EXIT_CODE == 124 )); then
    echo "got timeout after $TIMEOUT_SEC seconds"
    exit 1
fi

ASSET_SCORE=$(cat $LOG_FILE_PATH)
if ! (( ${#ASSET_SCORE} )); then
  echo "script failed"
  exit 1
elif (( ASSET_SCORE <= SCORE_THRESHOLD )); then
  echo "image received score $ASSET_SCORE, failing image builder pipeline"
  exit 1
fi

echo "test scan passed successfully"
exit 0
