# Component patterns and a local test loop

The service checks a component's YAML when you create it - but whether the component actually works (the commands, the conditionals, the package names) normally waits for the next pipeline build to reach the components step. This kit turns that loop into seconds: [awstoe-local.sh](awstoe-local.sh) downloads AWSTOE (the agent that executes component documents) and validates or runs your documents on your machine, and [cookbook/](cookbook/) holds component documents for the patterns that are hard to get right the first time. One CDK app ([cdk/](cdk/)) runs every cookbook component through a real pipeline.

## The local dev loop

```shell
./awstoe-local.sh validate cookbook/*.yml           # schema check, in about a second
./awstoe-local.sh run cookbook/conditional-install.yml --phases build
```

`validate` runs natively and catches unknown actions, misspelled fields, missing phases, and undeclared `{{ }}` references - most of what `CreateComponent` checks, here without a deploy, credentials, or a network, so it fits a pre-commit hook or CI. It checks against the host's action modules by default; `--os-platforms windows` (or `linux`, `darwin`) validates a document for another platform, so Windows components check out from a Linux machine. `run` is what needs no service equivalent: it executes the document inside an Amazon Linux 2023 container (built from the [Dockerfile](Dockerfile)) and drops the same logs a real build produces under `./awstoe-logs/` - on failure the script prints the console tail. `--parameters name=value,name2=value2` passes component parameters.

Components run with no sandbox, and a rebooting step writes to your crontab and calls `shutdown` - inside the container neither touches your machine, the filesystem the component mutates is thrown away, and the environment matches your pipeline's Amazon Linux build instances. `run --host` skips the container if you know exactly what a document does; it refuses to run as root, and local runs block the `Reboot` action module in both modes, though a bare `exit 194` still gets through on the host. The container isn't a sandbox for components you don't trust.

The script verifies the binary's GPG signature against the fingerprint published in the AWSTOE documentation before first use, and caches it.

### What local runs can't do

- This script's `run` executes Linux documents only, because its container is Amazon Linux 2023. Windows documents still validate from Linux (`--os-platforms windows`); executing one takes `awstoe.exe` on a Windows machine.
- Required parameters you don't pass render as empty strings locally; the service rejects them at build time.
- Actions that call AWS (`S3Download`, the secrets pattern, an S3-hosted document) need real credentials - export them as environment variables and they pass into the container. Everything else runs offline - set `AWS_EC2_METADATA_DISABLED=true` off-EC2 to skip a metadata-probe delay.
- A local run proves your document's logic, not the image: base-image contents, the instance profile, and the post-build cleanup only exist in a real build.

## The cookbook

Where a document installs or changes something, it pairs the build phase with a validate phase asserting the work on the build instance - the same shape Amazon's managed components use. The test phase belongs to assertion-only components that check the finished image (the managed `simple-boot-test-linux`, for example), not to components that configure things.

| Document | What it shows |
|---|---|
| [conditional-install.yml](cookbook/conditional-install.yml) | One component that works across distributions - step-level `if` with `binaryExists`, and the rule that skipped steps count as successful |
| [foreach-install.yml](cookbook/foreach-install.yml) | `forEach` loops - one step run once per list entry via `{{ loop.value }}` |
| [tolerated-failure.yml](cookbook/tolerated-failure.yml) | A step that's allowed to fail. `onFailure: Ignore` is the only tolerated-failure form - `Continue` runs the remaining steps but still fails the document, and the build with it |
| [web-download-verified.yml](cookbook/web-download-verified.yml) | `WebDownload` with checksum verification, so a tampered or truncated artifact fails the build |
| [secrets-at-build-time.yml](cookbook/secrets-at-build-time.yml) | Reading a secret at build time with the native `{{ aws:ssm: }}` reference: the instance profile resolves it on the instance, and the service keeps SecureString values out of its logs. The document takes the secret's name as an input, and the `resolve()` function turns it into the reference. Also reads Secrets Manager secrets through `/aws/reference/secretsmanager/<name>` (that path additionally needs `secretsmanager:GetSecretValue` on the instance role) |
| [reboot-and-resume.yml](cookbook/reboot-and-resume.yml) | Rebooting from inside a script: exit code 194 (3010 on Windows) reboots the instance and reruns the same step, so the step keeps an indicator file to make the rerun idempotent. Don't run this one locally |

## How components execute in Image Builder

- Steps run as root on Linux (`NT AUTHORITY\SYSTEM` on Windows), through the Systems Manager agent.
- The build and validate phases run on the build instance; the test phase runs on a fresh instance launched from the output image. Nothing on the build instance's disk carries into the test instance except what made it into the image.
- Components run in recipe order, and `{{ }}` chaining between steps only works inside the same document.
- When a component misbehaves in a real build, read the build log group (this kit's pipeline wires one) - it carries each step's console output and the full evaluation trace for conditionals and loops. AWSTOE's on-instance working files (`TOE_*` directories) sit in the system temp directory, so inspect them on a live instance - they don't survive into the image.
- On Amazon Linux 2023, `/tmp` is memory-backed (tmpfs): anything a component writes there is gone when the instance shuts down and never reaches the image. If a file is missing from your AMI, check whether it was written to `/tmp` - use a disk-backed path instead.

## What the build cleans up

Just before creating the image, Image Builder runs a cleanup that removes build artifacts and instance state - including every user's `.ssh/authorized_keys` and the SSH host keys, so keys a component installs during the build won't be in the image unless you skip that cleanup section. Each section can be skipped with an empty marker file (no file extension, created with the `CreateFile` action) in the recipe's working directory - the [security best practices page](https://docs.aws.amazon.com/imagebuilder/latest/userguide/security-best-practices.html) lists the sections, their markers, and what each one leaves in your image.

The markers go in the recipe's `workingDirectory` - this kit's recipe points it at a disk-backed path (`/opt/build-work`), since the default `/tmp` is tmpfs on Amazon Linux 2023 and hardened bases often mount it noexec. The one thing markers can't keep on Amazon Linux 2023 is the AWSTOE logs: they live under `/tmp`, gone before the image exists - copy them to a disk-backed path or S3 from a late build step instead.

## Cost

- Each pipeline build bills a t3.medium for the build duration, plus a second one briefly for the test phase.
- Each output AMI's snapshot bills until you deregister the AMI and delete the snapshot.
- The local loop costs nothing.

## Prerequisites

- Linux or macOS with `curl` and `gpg` for `validate`; Docker for `run`.
- For the pipeline: Node.js 20+, a bootstrapped CDK environment, and a default VPC in the deployment region.

## Deploy

The secrets component reads one SecureString parameter - create it first (CloudFormation can't create SecureStrings):

```shell
aws ssm put-parameter --name /cookbook/build-secret --type SecureString --value 'example-secret'
cd cdk
npm install
npx cdk deploy
```

For a real secret, pass `--value file://...` instead of an inline argument, which lands in shell history.

## Testing

1. Iterate locally first: `./awstoe-local.sh validate cookbook/*.yml`, then `run` the ones you're changing.
2. Start a build: `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <ImagePipelineArn output>`. The build reboots once mid-way (the reboot-and-resume component) and reaches `AVAILABLE` in about 15 minutes.
3. Launch an instance from the output AMI and check the components' work made it into the image: `unzip -v` and `rpm -q jq tar gzip` succeed, while the downloaded artifact is gone from `/tmp` and the build's instance state was cleaned up.

## Cleanup

1. Delete the image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the `awstoe-cookbook-*` AMIs and delete their snapshots.
3. `npx cdk destroy`, then delete the secret parameter: `aws ssm delete-parameter --name /cookbook/build-secret`.
4. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying, or the deploy fails on the name conflict.
