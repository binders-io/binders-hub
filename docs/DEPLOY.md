# Deploying Binders Hub

Every way of running the hub needs the same five things. The rest of this page is how each platform gives them.

| | What | Why |
|---|---|---|
| One hub | A single instance, never two at once | It keeps live state, WebSockets and agents' terminals in memory. Upgrades stop the old one before starting the new one. |
| A Redis that keeps its data | `appendonly yes` on a disk that survives restarts, or Amazon MemoryDB | The change log is the only copy of a change until GitHub has it. A cache that can drop data (ElastiCache without persistence) loses work. |
| The hub's data folder | `/app/hub/.data` in the image, on a persistent volume | Its notes repo, pictures, the working copies change sets merge in, and its secret when `HUB_SECRET` isn't set. |
| An HTTPS address | `PUBLIC_URL`, reachable by your team and by GitHub | GitHub sends webhooks and sign-ins there. The proxy in front must pass WebSockets (`/api/live`, terminals) and bodies up to 8 MB. Without a public address, the hub asks GitHub for changes instead of hearing them. |
| `HUB_SECRET` | A long random string, backed up | It seals GitHub's keys and everything else the hub keeps. Lose it and GitHub has to be set up again. |

The image is `ghcr.io/binders-io/binders-hub`, tagged with each release (`0.1.0`), its minor version (`0.1`) and `latest`, for amd64 and arm64. It listens on port 4400, runs as user 1000, answers `/health` while it's up and `/ready` once its Redis does. Every setting is described at the top of [hub/src/main.ts](../hub/src/main.ts), and [deploy/hub.env.example](../deploy/hub.env.example) has the ones you'll set.

After it starts, the steps are the same everywhere: open the one-time setup link it prints (its log has a line starting `set up:`), connect GitHub in Settings → GitHub, and add an agent in Agents. The README's [Self-host](../README.md#self-host) section walks through them.

## Docker Compose

The simplest: the hub and its Redis on one Linux server, with Caddy or nginx in front, or a Cloudflare tunnel. See the README's [Self-host](../README.md#self-host) section. [deploy/update.sh](../deploy/update.sh) with [deploy/systemd/binders-hub-update.timer](../deploy/systemd/binders-hub-update.timer) keeps it on the newest commit of a branch, running the tests before each update.

## Plain Docker

The same as Compose, by hand, with the published image:

```sh
docker network create binders
docker volume create binders-redis && docker volume create binders-hub

docker run -d --name binders-redis --network binders --restart unless-stopped \
  -v binders-redis:/data redis:8.8-alpine \
  redis-server --appendonly yes --appendfsync everysec --save '' --dir /data

docker run -d --name binders-hub --network binders --restart unless-stopped \
  -p 127.0.0.1:4400:4400 -v binders-hub:/app/hub/.data \
  --env-file /etc/binders/hub.env -e REDIS_URL=redis://binders-redis:6379 \
  ghcr.io/binders-io/binders-hub:0.1

docker logs binders-hub | grep "set up"
```

To update: `docker pull ghcr.io/binders-io/binders-hub:0.1`, then `docker rm -f binders-hub` and run it again. Its data stays in the volumes.

## Kubernetes, with Helm

[deploy/helm/binders-hub](../deploy/helm/binders-hub) runs the hub as one pod (`replicas: 1`, `strategy: Recreate`) with a volume for its data, a Redis StatefulSet with its own volume (or your own Redis), a Service and an optional Ingress. It makes the hub's secret on first install and keeps it, and the data volume, when the release is uninstalled.

```sh
helm install hub deploy/helm/binders-hub --namespace binders --create-namespace \
  --set publicUrl=https://hub.example.com \
  --set ingress.enabled=true --set ingress.host=hub.example.com --set ingress.className=nginx \
  --set-string 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt' \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size=8m' \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-read-timeout=3600'

kubectl logs -n binders deploy/hub-binders-hub | grep "set up"
```

Its [values.yaml](../deploy/helm/binders-hub/values.yaml) explains each setting: `env` for the hub's other settings (`HUB_ADMINS`…), `hubSecret.existingSecret` for a secret you manage, `redis.enabled: false` with `externalRedis` for your own Redis, `persistence` for storage classes and sizes. To get plain manifests instead, `helm template hub deploy/helm/binders-hub --set publicUrl=…`.

From a private registry: copy the image there, set `image.repository` (and `redis.image`, if Redis comes from there too), and name your pull Secret in `imagePullSecrets`, or have the chart make one from `imageCredentials`. Both pods use them.

On a cluster with its own conventions: `commonLabels` go on everything the chart makes, and `ingress.labels` on the Ingress alone (for an external-dns that only picks labelled Ingresses, say). `serviceAccount` runs the hub as a ServiceAccount the chart makes, with your annotations, or as one of yours. When `HUB_SECRET` comes from your own settings (`envFrom`, or a vault agent the cluster injects), set `hubSecret.fromEnvironment: true` and the chart stays out of it.

The hub's brain is set in **Settings → Brain**. To set it on the cluster instead, put `BRAIN_PROVIDER` and `BRAIN_MODEL` in `env` and its key (`BRAIN_API_KEY`, or `ANTHROPIC_API_KEY` for Claude) in a Secret you pass with `envFrom`. Transcription and speech take `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL`, and `SPEECH_BASE_URL`, `SPEECH_MODEL` and `SPEECH_VOICE`, with their keys (`TRANSCRIPTION_API_KEY`, `SPEECH_API_KEY`) in the Secret; `BRAIN_LOCAL_ONLY=1` keeps every model on the cluster's own network.

Use storage that only one node mounts at a time (`ReadWriteOnce`) and that survives the pod: the hub's notes are a Git repo, which doesn't belong on NFS shared by two writers.

## AWS: ECS on Fargate

[deploy/ecs/binders-hub.yml](../deploy/ecs/binders-hub.yml) is a CloudFormation template:

- one Fargate task with the hub and a Redis beside it, both on Graviton (ARM64)
- the hub's data and Redis's append-only file on encrypted EFS, with backups on
- an Application Load Balancer with your ACM certificate, redirecting HTTP to HTTPS
- the hub's secret in Secrets Manager
- logs in CloudWatch, and ECS Exec turned on for a shell when you need one

The service never runs two tasks: a deploy stops the old one first. The secret and the EFS file system are kept if the stack is deleted.

```sh
aws cloudformation deploy --stack-name binders-hub --template-file deploy/ecs/binders-hub.yml \
  --capabilities CAPABILITY_IAM --parameter-overrides \
  VpcId=vpc-… PublicSubnetIds=subnet-a,subnet-b TaskSubnetIds=subnet-c,subnet-d \
  CertificateArn=arn:aws:acm:… PublicUrl=https://hub.example.com HubAdmins=octocat

aws cloudformation describe-stacks --stack-name binders-hub --query 'Stacks[0].Outputs'
```

Point your hub's address at the `LoadBalancerDns` output, and find the setup link with the command in the `SetupLink` output.

- **Subnets:** `TaskSubnetIds` are exactly two subnets in different zones. If they're private, they need a NAT gateway so the task can pull its image and reach GitHub; if they're public, set `AssignPublicIp=ENABLED`.
- **Your own Redis:** set `RedisUrl` to an Amazon MemoryDB cluster (`rediss://…`, durable by design) and the task runs without its own Redis.
- **Updating:** change `Image` to a newer tag and deploy the stack again.

## Node, with systemd

Without Docker: Node 23.6 or newer, Git, and Redis with `appendonly yes`, on one Linux server.

```sh
sudo useradd --system --home /opt/binders-hub binders
sudo git clone https://github.com/binders-io/binders-hub.git /opt/binders-hub && cd /opt/binders-hub
sudo npm ci --prefix shared && sudo npm ci --prefix hub && sudo npm ci --prefix web && sudo npm ci --prefix runner
sudo npm run build --prefix web && sudo npm run build --prefix runner
sudo mkdir -p hub/.data /etc/binders && sudo chown -R binders:binders hub/.data
sudo cp deploy/hub.env.example /etc/binders/hub.env      # set PUBLIC_URL and HUB_SECRET
sudo cp deploy/systemd/binders-hub.service /etc/systemd/system/ && sudo systemctl enable --now binders-hub
journalctl -u binders-hub | grep "set up"
```

The hub listens on `127.0.0.1:4400`; put Caddy or nginx in front for HTTPS. To update: `git pull`, the same `npm ci` and builds, then `sudo systemctl restart binders-hub`.

## Backups

Back up three things together: Redis's append-only file, the hub's data folder, and `HUB_SECRET`. With them, a hub moves to a new server whole: restore them there, start it with the same `PUBLIC_URL`, and runners and GitHub carry on. A hub at a new address needs that address added to its GitHub App's callback URLs; it points the app's webhook at itself when it starts.
